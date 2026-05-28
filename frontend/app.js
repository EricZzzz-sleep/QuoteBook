const DB_NAME = "reading-tracker";
const DB_VERSION = 1;
const BOOK_STORE = "books";
const PDF_JS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";
const PDF_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

let dbPromise;
let uploadInProgress = false;

function openDatabase() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BOOK_STORE)) {
        db.createObjectStore(BOOK_STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

async function withStore(mode, callback) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(BOOK_STORE, mode);
    const store = transaction.objectStore(BOOK_STORE);
    const request = callback(store);
    let result;

    request.onsuccess = () => {
      result = request.result;
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
  });
}

async function getSavedBooks() {
  const books = (await withStore("readonly", (store) => store.getAll())) || [];
  return ensureBookCoverImages(books);
}

async function getBook(id) {
  return withStore("readonly", (store) => store.get(id));
}

async function saveBook(book) {
  await withStore("readwrite", (store) => store.put(book));
}

async function ensureBookCoverImages(books) {
  const updatedBooks = [];

  for (const book of books) {
    if (!book.coverImage && book.pdfBlob) {
      try {
        const info = await getPdfInfo(book.pdfBlob);
        book.coverImage = info.coverImage;
        book.totalPages = book.totalPages || info.totalPages;
        book.updatedAt = new Date().toISOString();
        await saveBook(book);
      } catch (error) {
        console.warn("Could not generate cover image", error);
      }
    }
    updatedBooks.push(book);
  }

  return updatedBooks;
}

async function updateBookPage(id, currentPage) {
  const book = await getBook(id);
  if (!book) return;
  book.currentPage = currentPage;
  book.updatedAt = new Date().toISOString();
  await saveBook(book);
}

async function updateBookDetails(id, title, author) {
  const book = await getBook(id);
  if (!book) return null;
  book.title = title;
  book.author = author;
  book.cover = getInitials(title);
  book.updatedAt = new Date().toISOString();
  await saveBook(book);
  return book;
}

function getInitials(title) {
  return title
    .replace(/\.pdf$/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("") || "PDF";
}

function formatTitle(fileName) {
  return fileName
    .replace(/\.pdf$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeTitle(value) {
  return value.replace(/\s+/g, " ").trim();
}

function progressPercent(book) {
  if (!book.totalPages) return 0;
  return Math.round((book.currentPage / book.totalPages) * 100);
}

function createCoverMarkup(book, size = "small") {
  const className = size === "large" ? "large-cover" : "book-cover";
  const cover = escapeHtml(book.cover || getInitials(book.title));

  if (book.coverImage) {
    return `
      <div class="${className} pdf-cover">
        <img src="${escapeHtml(book.coverImage)}" alt="${escapeHtml(book.title)} cover">
      </div>
    `;
  }

  return `<div class="${className} ${book.color || "cover-teal"}"><span>${cover}</span></div>`;
}

async function loadPdfJs() {
  const pdfjs = await import(PDF_JS_URL);
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
  return pdfjs;
}

async function getPdfInfo(file) {
  const pdfjs = await loadPdfJs();
  const buffer = await file.arrayBuffer();
  const loadingTask = pdfjs.getDocument({ data: buffer.slice(0) });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(1);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = 360 / baseViewport.width;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: context, viewport }).promise;

  return {
    totalPages: pdf.numPages,
    coverImage: canvas.toDataURL("image/jpeg", 0.82),
  };
}

async function handlePdfUpload(file) {
  if (uploadInProgress) return;
  if (!file || (file.type && file.type !== "application/pdf") || !file.name.toLowerCase().endsWith(".pdf")) {
    alert("Please choose a PDF file.");
    return;
  }

  uploadInProgress = true;
  const { totalPages, coverImage } = await getPdfInfo(file);
  const title = formatTitle(file.name);
  const book = {
    id: crypto.randomUUID(),
    title,
    fileName: file.name,
    pdfBlob: file,
    totalPages,
    currentPage: 1,
    uploadedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    notes: [],
    vocabulary: [],
    summaries: [],
    author: "",
    cover: getInitials(title),
    coverImage,
    color: "cover-teal",
  };

  await saveBook(book);
  window.location.href = `reader.html?id=${book.id}`;
}

function bindUploadButtons() {
  const buttons = document.querySelectorAll("[data-upload-pdf], .primary-action");
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/pdf";
  input.hidden = true;
  document.body.append(input);

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;

    try {
      await handlePdfUpload(file);
    } catch (error) {
      console.error(error);
      alert("The PDF could not be opened. Please try another file.");
    } finally {
      input.value = "";
      uploadInProgress = false;
    }
  });

  buttons.forEach((button) => {
    const text = button.textContent?.toLowerCase() || "";
    if (!button.matches("[data-upload-pdf]") && !text.includes("upload")) return;
    button.addEventListener("click", () => input.click());
  });
}

function ensureBookDetailsDialog() {
  let dialog = document.querySelector("[data-book-details-dialog]");
  if (dialog) return dialog;

  dialog = document.createElement("div");
  dialog.className = "modal-backdrop";
  dialog.dataset.bookDetailsDialog = "";
  dialog.hidden = true;
  dialog.innerHTML = `
    <form class="book-details-modal" data-book-details-form>
      <div>
        <p class="eyebrow">Book details</p>
        <h2>Rename book</h2>
      </div>
      <label class="field-label">
        <span>Book name</span>
        <input class="field-input" name="title" type="text" required maxlength="120" autocomplete="off">
      </label>
      <label class="field-label">
        <span>Author</span>
        <input class="field-input" name="author" type="text" maxlength="100" autocomplete="off" placeholder="Unknown author">
      </label>
      <div class="modal-actions">
        <button class="ghost-action" type="button" data-close-book-details>Cancel</button>
        <button class="primary-action" type="submit">Save</button>
      </div>
    </form>
  `;
  document.body.append(dialog);
  return dialog;
}

async function openBookDetailsDialog(id) {
  const book = await getBook(id);
  if (!book) return;

  const dialog = ensureBookDetailsDialog();
  const form = dialog.querySelector("[data-book-details-form]");
  const title = form.elements.title;
  const author = form.elements.author;
  form.dataset.bookId = id;
  title.value = book.title;
  author.value = book.author || "";
  dialog.hidden = false;
  title.focus();
  title.select();
}

function closeBookDetailsDialog() {
  const dialog = document.querySelector("[data-book-details-dialog]");
  if (dialog) dialog.hidden = true;
}

async function saveBookDetails(form) {
  const id = form.dataset.bookId;
  const nextTitle = normalizeTitle(form.elements.title.value);
  const nextAuthor = normalizeTitle(form.elements.author.value);
  if (!id || !nextTitle) return;

  await updateBookDetails(id, nextTitle, nextAuthor);
  closeBookDetailsDialog();
  await refreshCurrentPage();
}

function bindRenameControls() {
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-rename-book]");
    if (button) {
      event.preventDefault();
      await openBookDetailsDialog(button.dataset.renameBook);
      return;
    }

    if (event.target.closest("[data-close-book-details]")) {
      closeBookDetailsDialog();
    }
  });

  document.addEventListener("submit", async (event) => {
    const form = event.target.closest("[data-book-details-form]");
    if (!form) return;
    event.preventDefault();
    await saveBookDetails(form);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeBookDetailsDialog();
  });
}

function createBookCard(book) {
  const percent = progressPercent(book);
  const notes = Array.isArray(book.notes) ? book.notes.length : book.notes || 0;
  const vocabulary = Array.isArray(book.vocabulary) ? book.vocabulary.length : book.vocabulary || 0;
  const summaries = Array.isArray(book.summaries) ? book.summaries.length : book.summaries || 0;
  const title = escapeHtml(book.title);
  const author = book.author ? ` by ${escapeHtml(book.author)}` : "";
  const href = `reader.html?id=${encodeURIComponent(book.id)}`;

  return `
    <article class="shelf-book real-book-card">
      <a class="book-open-link" href="${href}">
        ${createCoverMarkup(book, "large")}
        <div class="shelf-book-body">
          <span class="status-pill light">Uploaded PDF</span>
          <h2>${title}</h2>
          <p>Page ${book.currentPage} of ${book.totalPages}${author}</p>
          <div class="mini-track" aria-hidden="true"><span style="width: ${percent}%"></span></div>
          <div class="capture-summary">
            <span>${notes} notes</span>
            <span>${vocabulary} vocabulary</span>
            <span>${summaries} summaries</span>
          </div>
        </div>
      </a>
      <button class="rename-book-button" type="button" data-rename-book="${escapeHtml(book.id)}">Rename</button>
    </article>
  `;
}

function createDashboardBook(book) {
  const percent = progressPercent(book);
  const notes = Array.isArray(book.notes) ? book.notes.length : book.notes || 0;
  const vocabulary = Array.isArray(book.vocabulary) ? book.vocabulary.length : book.vocabulary || 0;
  const title = escapeHtml(book.title);
  const author = book.author ? ` by ${escapeHtml(book.author)}` : "";

  return `
    <article class="book-card book-card-expanded">
      <div class="book-row">
        ${createCoverMarkup(book)}
        <div class="book-info">
          <h3>${title}</h3>
          <p>Page ${book.currentPage} of ${book.totalPages}${author}</p>
          <div class="mini-track" aria-hidden="true"><span style="width: ${percent}%"></span></div>
        </div>
        <span class="book-percent">${percent}%</span>
      </div>
      <div class="book-captures">
        <div>
          <span class="capture-label">Notes</span>
          <strong>${notes}</strong>
          <p>Ready for notes in the next step.</p>
        </div>
        <div>
          <span class="capture-label">Vocabulary</span>
          <strong>${vocabulary}</strong>
          <p>Ready for vocabulary marks.</p>
        </div>
      </div>
    </article>
  `;
}

function renderDashboardHero(books) {
  const title = document.querySelector("[data-hero-title]");
  if (!title) return;

  const status = document.querySelector("[data-hero-status]");
  const meta = document.querySelector("[data-hero-meta]");
  const progress = document.querySelector("[data-hero-progress]");
  const progressBar = document.querySelector("[data-hero-progress-bar]");
  const latest = books[0];

  if (!latest) {
    status.textContent = "Upload a PDF";
    title.textContent = "Your real books will appear here.";
    meta.textContent = "Choose a PDF to create a saved book with its own reader and progress.";
    progress.textContent = "0%";
    progressBar.style.width = "0%";
    return;
  }

  const percent = progressPercent(latest);
  status.textContent = "Currently reading";
  title.textContent = latest.title;
  meta.textContent = `${latest.author ? `By ${latest.author}. ` : ""}Page ${latest.currentPage} of ${latest.totalPages}. This book is stored locally in your browser.`;
  progress.textContent = `${percent}%`;
  progressBar.style.width = `${percent}%`;
}

function fitSidebarText() {
  document.querySelectorAll(".sidebar-panel strong").forEach((element) => {
    const length = element.textContent.trim().length;
    let size = "1.75rem";
    if (length > 48) size = "0.88rem";
    else if (length > 34) size = "1rem";
    else if (length > 22) size = "1.2rem";
    else if (length > 14) size = "1.45rem";
    element.style.fontSize = size;
  });
}

function renderEmptyState(container, message) {
  container.innerHTML = `
    <div class="empty-library">
      <strong>No uploaded books yet</strong>
      <p>${message}</p>
    </div>
  `;
}

async function renderShelf() {
  const grid = document.querySelector("[data-book-grid]");
  if (!grid) return;

  const books = await getSavedBooks();
  if (!books.length) {
    renderEmptyState(grid, "Upload a PDF to create your first real book.");
    return;
  }

  grid.innerHTML = books.map(createBookCard).join("");
}

async function renderDashboard() {
  const list = document.querySelector("[data-dashboard-books]");
  if (!list) return;

  const books = await getSavedBooks();
  renderDashboardHero(books);
  if (!books.length) {
    renderEmptyState(list, "Your uploaded PDFs will appear here with reading progress.");
  } else {
    list.innerHTML = books.map(createDashboardBook).join("");
  }

  const bookCount = document.querySelector("[data-stat-books]");
  if (bookCount) bookCount.textContent = String(books.length);
  fitSidebarText();
}

async function renderNotesAndVocabulary() {
  const saved = await getSavedBooks();

  const notesColumn = document.querySelector("[data-real-notes]");
  if (notesColumn) {
    if (!saved.length) {
      renderEmptyState(notesColumn, "Upload a PDF first. Notes will be grouped under each real book.");
    } else {
      notesColumn.innerHTML = saved
        .map(
          (book) => `
            <section class="book-notebook" aria-label="${escapeHtml(book.title)} notes">
              <div class="book-notebook-header">
                ${createCoverMarkup(book)}
                <div>
                  <span class="note-type">Uploaded book</span>
                  <h2>${escapeHtml(book.title)}</h2>
                  <p>${book.author ? `By ${escapeHtml(book.author)}. ` : ""}${book.notes.length} notes, ${book.vocabulary.length} vocabulary words, ${book.summaries.length} summaries</p>
                </div>
              </div>
              <article class="embedded-note">
                <span>Ready for notes</span>
                <p>Open this PDF from Shelf to continue reading. Notes for this book will live here next.</p>
              </article>
            </section>
          `
        )
        .join("");
    }
  }

  const wordGrid = document.querySelector("[data-real-vocabulary]");
  if (wordGrid) {
    if (!saved.length) {
      renderEmptyState(wordGrid, "Upload a PDF first. Vocabulary will be grouped under each real book.");
    } else {
      wordGrid.innerHTML = saved
        .map(
          (book) => `
            <article class="word-card book-word-card">
              <div class="book-notebook-header">
                ${createCoverMarkup(book)}
                <div>
                  <span class="note-type">${escapeHtml(book.title)}</span>
                  <h2>${book.vocabulary.length} saved words</h2>
                </div>
              </div>
              <div class="word-list">
                <div><strong>Ready for vocabulary</strong><span>Words marked while reading this PDF will appear here.</span></div>
              </div>
            </article>
          `
        )
        .join("");
    }
  }
  fitSidebarText();
}

async function refreshCurrentPage() {
  await renderDashboard();
  await renderShelf();
  await renderNotesAndVocabulary();

  if (document.body.dataset.page === "reader") {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    const book = id ? await getBook(id) : null;
    if (!book) return;

    document.querySelector("#readerTitle").textContent = book.title;
    document.querySelector("#readerSidebarTitle").textContent = book.title;
    document.querySelector("#readerSidebarMeta").textContent = `${book.author ? `By ${book.author}. ` : ""}Page ${book.currentPage} of ${book.totalPages}`;
    fitSidebarText();
  }
}

async function renderReader() {
  const canvas = document.querySelector("#pdfCanvas");
  if (!canvas) return;

  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");
  const message = document.querySelector("#readerMessage");
  const book = id ? await getBook(id) : null;

  if (!book) {
    message.textContent = "Book not found. Return to Shelf and choose an uploaded PDF.";
    return;
  }

  const pdfjs = await loadPdfJs();
  const buffer = await book.pdfBlob.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buffer }).promise;
  let currentPage = Math.min(Math.max(book.currentPage || 1, 1), pdf.numPages);

  const title = document.querySelector("#readerTitle");
  const sidebarTitle = document.querySelector("#readerSidebarTitle");
  const sidebarMeta = document.querySelector("#readerSidebarMeta");
  const pageStatus = document.querySelector("#pageStatus");
  const progressStatus = document.querySelector("#progressStatus");
  const progressBar = document.querySelector("#readerProgressBar");
  const prev = document.querySelector("#prevPage");
  const next = document.querySelector("#nextPage");
  const rename = document.querySelector("#readerRename");
  const context = canvas.getContext("2d");

  title.textContent = book.title;
  sidebarTitle.textContent = book.title;
  rename.dataset.renameBook = book.id;
  fitSidebarText();

  async function drawPage(pageNumber) {
    message.hidden = true;
    const page = await pdf.getPage(pageNumber);
    const containerWidth = Math.min(canvas.parentElement.clientWidth - 32, 980);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = containerWidth / baseViewport.width;
    const viewport = page.getViewport({ scale });

    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({ canvasContext: context, viewport }).promise;
    const percent = Math.round((pageNumber / pdf.numPages) * 100);
    pageStatus.textContent = `Page ${pageNumber} of ${pdf.numPages}`;
    progressStatus.textContent = `${percent}% complete`;
    progressBar.style.width = `${percent}%`;
    sidebarMeta.textContent = `${book.author ? `By ${book.author}. ` : ""}Page ${pageNumber} of ${pdf.numPages}`;
    prev.disabled = pageNumber <= 1;
    next.disabled = pageNumber >= pdf.numPages;
    await updateBookPage(book.id, pageNumber);
  }

  prev.addEventListener("click", async () => {
    if (currentPage <= 1) return;
    currentPage -= 1;
    await drawPage(currentPage);
  });

  next.addEventListener("click", async () => {
    if (currentPage >= pdf.numPages) return;
    currentPage += 1;
    await drawPage(currentPage);
  });

  window.addEventListener("resize", () => {
    window.clearTimeout(window.readerResizeTimer);
    window.readerResizeTimer = window.setTimeout(() => drawPage(currentPage), 180);
  });

  await drawPage(currentPage);
}

async function init() {
  bindUploadButtons();
  bindRenameControls();
  await renderDashboard();
  await renderShelf();
  await renderNotesAndVocabulary();
  await renderReader();
  fitSidebarText();
}

init().catch((error) => {
  console.error(error);
  alert("Reading Tracker could not start. Please refresh and try again.");
});
