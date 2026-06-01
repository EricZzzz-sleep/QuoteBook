const DB_NAME = "reading-tracker";
const DB_VERSION = 1;
const BOOK_STORE = "books";
const DEFAULT_API_BASE_URL = window.location.protocol === "file:" ? "http://localhost:8000" : window.location.origin;
const API_BASE_URL = window.READING_TRACKER_API_URL || DEFAULT_API_BASE_URL;
const PDF_JS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";
const PDF_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";
const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
const JSPDF_URL = "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js";

let dbPromise;
let uploadInProgress = false;
let storagePersistencePromise;
let tesseractPromise;
let jsPdfPromise;

function ensureStatusRegion() {
  let region = document.querySelector("[data-app-status]");
  if (region) return region;

  region = document.createElement("div");
  region.className = "app-status";
  region.dataset.appStatus = "";
  region.setAttribute("role", "status");
  region.setAttribute("aria-live", "polite");
  document.body.append(region);
  return region;
}

function showStatus(message, type = "info") {
  const region = ensureStatusRegion();
  region.textContent = message;
  region.dataset.statusType = type;
  region.hidden = false;

  window.clearTimeout(region.hideTimer);
  region.hideTimer = window.setTimeout(() => {
    region.hidden = true;
  }, type === "error" ? 7000 : 4200);
}

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
  let backendBooks = [];
  let backendAvailable = false;

  try {
    backendBooks = await getBackendBooks();
    backendAvailable = true;
  } catch (error) {
    console.warn("Backend unavailable, using browser storage", error);
  }

  if (backendBooks.length) {
    return sortBooksByUpdatedAt(backendBooks);
  }

  let localBooks = [];
  try {
    localBooks = (await withStore("readonly", (store) => store.getAll())) || [];
    ensureBookCoverImages(localBooks).catch((error) => {
      console.warn("Could not refresh local book covers", error);
    });
  } catch (error) {
    if (!backendAvailable) throw error;
    console.warn("Browser storage unavailable, using backend library", error);
  }

  const mergedBooks = new Map();
  localBooks.forEach((book) => mergedBooks.set(book.id, book));
  backendBooks.forEach((book) => mergedBooks.set(book.id, book));

  return sortBooksByUpdatedAt(Array.from(mergedBooks.values()));
}

function sortBooksByUpdatedAt(books) {
  return books.sort((first, second) => {
    return new Date(second.updatedAt || 0) - new Date(first.updatedAt || 0);
  });
}

async function getBook(id) {
  try {
    return await getBackendBook(id);
  } catch (error) {
    console.warn("Backend unavailable, using browser storage", error);
  }

  return withStore("readonly", (store) => store.get(id));
}

async function saveBook(book) {
  await withStore("readwrite", (store) => store.put(book));
}

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "The backend request failed.");
  }
  return data;
}

async function getBackendBooks() {
  const data = await apiRequest("/api/books/");
  return data.books || [];
}

async function getBackendBook(id) {
  const data = await apiRequest(`/api/books/${encodeURIComponent(id)}/`);
  return data.book;
}

async function getBackendStats() {
  const data = await apiRequest("/api/stats/");
  return data.stats;
}

async function uploadBookToBackend(file, metadata) {
  const formData = new FormData();
  formData.append("pdf", file);
  Object.entries(metadata).forEach(([key, value]) => {
    formData.append(key, value);
  });

  const data = await apiRequest("/api/books/", {
    method: "POST",
    body: formData,
  });
  return data.book;
}

async function requestPersistentLocalStorage() {
  if (storagePersistencePromise) return storagePersistencePromise;

  storagePersistencePromise = (async () => {
    if (!navigator.storage?.persist) return false;

    try {
      if (navigator.storage.persisted && (await navigator.storage.persisted())) {
        return true;
      }

      return navigator.storage.persist();
    } catch (error) {
      console.warn("Persistent storage could not be requested", error);
      return false;
    }
  })();

  return storagePersistencePromise;
}

async function verifySavedPdf(id) {
  const saved = await getBook(id);
  return Boolean(saved?.pdfBlob && saved.pdfBlob.size > 0);
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
  try {
    await apiRequest(`/api/books/${encodeURIComponent(id)}/`, {
      method: "PATCH",
      body: JSON.stringify({ currentPage }),
    });
    return;
  } catch (error) {
    console.warn("Backend unavailable, saving page locally", error);
  }

  const book = await getBook(id);
  if (!book) return;
  book.currentPage = currentPage;
  const now = new Date().toISOString();
  book.lastReadAt = now;
  book.updatedAt = now;
  const dates = Array.isArray(book.readingDates) ? book.readingDates : [];
  const today = todayKey();
  book.readingDates = dates.includes(today) ? dates : [...dates, today];
  await saveBook(book);
}

async function updateBookDetails(id, title, author) {
  try {
    const data = await apiRequest(`/api/books/${encodeURIComponent(id)}/`, {
      method: "PATCH",
      body: JSON.stringify({ title, author, cover: getInitials(title) }),
    });
    return data.book;
  } catch (error) {
    console.warn("Backend unavailable, saving details locally", error);
  }

  const book = await getBook(id);
  if (!book) return null;
  book.title = title;
  book.author = author;
  book.cover = getInitials(title);
  book.updatedAt = new Date().toISOString();
  await saveBook(book);
  return book;
}

async function deleteBook(id) {
  try {
    await apiRequest(`/api/books/${encodeURIComponent(id)}/`, {
      method: "DELETE",
    });
    return;
  } catch (error) {
    console.warn("Backend unavailable, deleting book locally", error);
  }

  await withStore("readwrite", (store) => store.delete(id));
}

async function addBookCapture(id, type, data) {
  try {
    const response = await apiRequest(`/api/books/${encodeURIComponent(id)}/captures/`, {
      method: "POST",
      body: JSON.stringify({ type, ...data }),
    });
    return response.capture;
  } catch (error) {
    console.warn("Backend unavailable, saving capture locally", error);
  }

  const book = await getBook(id);
  if (!book) return null;

  const capture = {
    id: crypto.randomUUID(),
    page: data.page,
    createdAt: new Date().toISOString(),
    ...data,
  };

  if (!Array.isArray(book[type])) book[type] = [];
  book[type].unshift(capture);
  book.updatedAt = new Date().toISOString();
  await saveBook(book);
  return capture;
}

async function deleteBookQuote(bookId, quoteId) {
  try {
    const response = await apiRequest(`/api/books/${encodeURIComponent(bookId)}/captures/${encodeURIComponent(quoteId)}/`, {
      method: "DELETE",
    });
    return response.book || null;
  } catch (error) {
    console.warn("Backend unavailable, deleting quote locally", error);
  }

  const book = await getBook(bookId);
  if (!book) return null;
  const notes = Array.isArray(book.notes) ? book.notes : [];
  book.notes = notes.filter((note) => String(note.id) !== String(quoteId));
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

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getBookLastReadAt(book) {
  return book.lastReadAt || book.updatedAt || book.uploadedAt || "";
}

function formatRelativeDate(value) {
  if (!value) return "Not read yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unknown";
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((startOfToday - startOfDate) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return formatDate(value);
}

function normalizeTags(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  return source
    .map((tag) => normalizeCaptureText(tag).replace(/^#/, ""))
    .filter(Boolean)
    .slice(0, 8);
}

function truncateEnd(value, maxLength = 50) {
  const text = normalizeCaptureText(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength).trimEnd()}...` : text;
}

function getReadingDates(book) {
  const dates = Array.isArray(book.readingDates) ? book.readingDates : [];
  const lastRead = getBookLastReadAt(book);
  const lastReadDate = lastRead ? lastRead.slice(0, 10) : "";
  return Array.from(new Set([...dates, lastReadDate].filter(Boolean)));
}

function normalizeCaptureText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Saved date unknown";

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function getOcrCacheKey(bookId, pageNumber) {
  return `reading-tracker-ocr-v1:${bookId}:${pageNumber}`;
}

function readOcrCache(bookId, pageNumber) {
  try {
    const value = localStorage.getItem(getOcrCacheKey(bookId, pageNumber));
    return value ? JSON.parse(value) : null;
  } catch (error) {
    console.warn("OCR cache could not be read", error);
    return null;
  }
}

function writeOcrCache(bookId, pageNumber, words) {
  try {
    localStorage.setItem(getOcrCacheKey(bookId, pageNumber), JSON.stringify(words));
  } catch (error) {
    console.warn("OCR cache could not be written", error);
  }
}

function progressPercent(book) {
  if (!book.totalPages) return 0;
  return Math.round((book.currentPage / book.totalPages) * 100);
}

function captureCount(book, type) {
  const captures = book[type];
  if (Array.isArray(captures)) return captures.length;
  const count = Number(captures);
  return Number.isFinite(count) ? count : 0;
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function getNotePage(page) {
  const number = Number(page);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 1;
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

async function loadTesseract() {
  if (window.Tesseract) return window.Tesseract;
  if (tesseractPromise) return tesseractPromise;

  tesseractPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TESSERACT_URL;
    script.async = true;
    script.onload = () => resolve(window.Tesseract);
    script.onerror = () => reject(new Error("Tesseract.js could not be loaded."));
    document.head.append(script);
  });

  return tesseractPromise;
}

async function loadJsPdf() {
  if (window.jspdf?.jsPDF) return window.jspdf.jsPDF;
  if (jsPdfPromise) return jsPdfPromise;

  jsPdfPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = JSPDF_URL;
    script.async = true;
    script.onload = () => {
      if (window.jspdf?.jsPDF) resolve(window.jspdf.jsPDF);
      else reject(new Error("PDF export library could not be loaded."));
    };
    script.onerror = () => reject(new Error("PDF export library could not be loaded."));
    document.head.append(script);
  });

  return jsPdfPromise;
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

async function getBookPdfBuffer(book) {
  if (book.pdfBlob) {
    return book.pdfBlob.arrayBuffer();
  }

  if (book.pdfUrl) {
    const response = await fetch(book.pdfUrl);
    if (!response.ok) throw new Error("The saved PDF could not be loaded.");
    return response.arrayBuffer();
  }

  throw new Error("This book does not have a saved PDF.");
}

async function handlePdfUpload(file) {
  if (uploadInProgress) return;
  if (!file || (file.type && file.type !== "application/pdf") || !file.name.toLowerCase().endsWith(".pdf")) {
    showStatus("Please choose a PDF file.", "error");
    return;
  }

  uploadInProgress = true;
  showStatus("Opening PDF...");
  const { totalPages, coverImage } = await getPdfInfo(file);
  const title = formatTitle(file.name);

  try {
    showStatus("Saving PDF to the backend...");
    const backendBook = await uploadBookToBackend(file, {
      title,
      totalPages,
      cover: getInitials(title),
      coverImage,
      color: "cover-teal",
    });
    window.location.href = `reader.html?id=${backendBook.id}`;
    return;
  } catch (error) {
    console.warn("Backend upload unavailable, saving PDF in browser storage", error);
    showStatus("Backend unavailable. Saving this PDF in browser storage instead.");
  }

  const storagePersisted = await requestPersistentLocalStorage();
  const pdfBlob = file.slice(0, file.size, file.type || "application/pdf");
  const book = {
    id: crypto.randomUUID(),
    title,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type || "application/pdf",
    pdfBlob,
    totalPages,
    currentPage: 1,
    uploadedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    storagePersisted,
    notes: [],
    vocabulary: [],
    summaries: [],
    lastReadAt: "",
    readingDates: [],
    author: "",
    cover: getInitials(title),
    coverImage,
    color: "cover-teal",
  };

  await saveBook(book);
  if (!(await verifySavedPdf(book.id))) {
    throw new Error("The PDF could not be saved locally.");
  }

  showStatus("PDF saved. Opening reader...");
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
      showStatus("The PDF could not be opened or saved. Please try another file.", "error");
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

function getActiveShelfFilter() {
  return document.querySelector("[data-shelf-filter].active")?.dataset.shelfFilter || "all";
}

function getActiveShelfSort() {
  return document.querySelector("[data-shelf-sort]")?.value || "recent";
}

function matchesShelfFilter(book, filter) {
  const currentPage = Number(book.currentPage || 1);

  if (filter === "to-read") return currentPage <= 1;
  return true;
}

function sortShelfBooks(books, sort) {
  const sorted = [...books];
  if (sort === "title") {
    return sorted.sort((first, second) => String(first.title || "").localeCompare(String(second.title || "")));
  }
  if (sort === "quotes") {
    return sorted.sort((first, second) => captureCount(second, "notes") - captureCount(first, "notes"));
  }
  return sorted.sort((first, second) => new Date(getBookLastReadAt(second) || 0) - new Date(getBookLastReadAt(first) || 0));
}

function bindShelfFilters() {
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-shelf-filter]");
    if (!button) return;

    document.querySelectorAll("[data-shelf-filter]").forEach((chip) => {
      const active = chip === button;
      chip.classList.toggle("active", active);
      chip.setAttribute("aria-pressed", String(active));
    });

    await renderShelf();
  });

  document.addEventListener("change", async (event) => {
    if (!event.target.matches("[data-shelf-sort]")) return;
    await renderShelf();
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

    const deleteButton = event.target.closest("[data-delete-book]");
    if (deleteButton) {
      event.preventDefault();
      const book = await getBook(deleteButton.dataset.deleteBook);
      if (!book) return;
      const confirmed = window.confirm(`Delete "${book.title}" from your shelf? This removes its PDF and saved notes.`);
      if (!confirmed) return;
      await deleteBook(book.id);
      showStatus("Book deleted.");
      await refreshCurrentPage();
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

function bindNotesTools() {
  document.addEventListener("click", async (event) => {
    const deleteButton = event.target.closest("[data-delete-quote]");
    if (deleteButton) {
      event.preventDefault();
      const quoteId = deleteButton.dataset.deleteQuote;
      const bookId = deleteButton.dataset.deleteQuoteBook || new URLSearchParams(window.location.search).get("id");
      if (!bookId || !quoteId) return;
      const confirmed = window.confirm("Delete this quote?");
      if (!confirmed) return;
      await deleteBookQuote(bookId, quoteId);
      window.dispatchEvent(new CustomEvent("reading-tracker:quote-deleted", {
        detail: { bookId, quoteId },
      }));
      showStatus("Quote deleted.");
      await refreshCurrentPage();
      return;
    }

    if (!event.target.closest("[data-export-book-pdf]")) return;

    const id = new URLSearchParams(window.location.search).get("id");
    const book = id ? await getBook(id) : null;
    if (!book) {
      showStatus("Choose a book before exporting.", "error");
      return;
    }

    try {
      await exportBookQuotesPdf(book);
      showStatus("Quote PDF exported.");
    } catch (error) {
      console.error(error);
      showStatus("The quote PDF could not be exported.", "error");
    }
  });
}

function createBookCard(book) {
  const percent = progressPercent(book);
  const notes = captureCount(book, "notes");
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
          <p class="book-momentum">Last opened ${escapeHtml(formatRelativeDate(getBookLastReadAt(book)))}</p>
          <div class="mini-track" aria-hidden="true"><span style="width: ${percent}%"></span></div>
          <div class="capture-summary">
            <span>${notes} notes</span>
          </div>
        </div>
      </a>
      <div class="book-card-actions">
        <button class="rename-book-button" type="button" data-rename-book="${escapeHtml(book.id)}">Edit details</button>
        <button class="delete-book-button" type="button" data-delete-book="${escapeHtml(book.id)}">Delete</button>
      </div>
    </article>
  `;
}

function createDashboardBook(book) {
  const percent = progressPercent(book);
  const notes = captureCount(book, "notes");
  const title = escapeHtml(book.title);
  const author = book.author ? ` by ${escapeHtml(book.author)}` : "";

  return `
    <article class="book-card book-card-expanded">
      <div class="book-row">
        ${createCoverMarkup(book)}
        <div class="book-info">
          <h3>${title}</h3>
          <p>Page ${book.currentPage} of ${book.totalPages}${author} &middot; Last read ${escapeHtml(formatRelativeDate(getBookLastReadAt(book)))}</p>
          <div class="mini-track" aria-hidden="true"><span style="width: ${percent}%"></span></div>
        </div>
        <span class="book-percent">${percent}%</span>
      </div>
      <div class="book-captures">
        <div>
          <span class="capture-label">Notes</span>
          <strong>${notes}</strong>
          <p>${notes ? "Saved while reading this PDF." : "Add quote notes from the reader."}</p>
        </div>
        <div>
          <span class="capture-label">Last opened</span>
          <strong>${escapeHtml(formatRelativeDate(getBookLastReadAt(book)))}</strong>
          <p>Return to the page where your notes live.</p>
        </div>
      </div>
      <a class="continue-link" href="reader.html?id=${encodeURIComponent(book.id)}">Open notebook</a>
    </article>
  `;
}

function createNotesBookCard(book) {
  const percent = progressPercent(book);
  const quotes = captureCount(book, "notes");
  const title = escapeHtml(book.title);
  const author = book.author ? ` by ${escapeHtml(book.author)}` : "";
  const href = `quotes.html?id=${encodeURIComponent(book.id)}`;

  return `
    <article class="book-notebook notes-book-card">
      <a class="notes-book-link" href="${href}">
        <div class="book-notebook-header">
          ${createCoverMarkup(book)}
          <div>
            <span class="note-type">Uploaded book</span>
            <h2>${title}</h2>
            <p>Page ${book.currentPage} of ${book.totalPages}${author}</p>
          </div>
        </div>
        <div class="mini-track" aria-hidden="true"><span style="width: ${percent}%"></span></div>
        <div class="notes-book-meta">
          <span>${pluralize(quotes, "quote")}</span>
        </div>
      </a>
    </article>
  `;
}

function createQuoteCard(note, options = {}) {
  const noteText = normalizeCaptureText(note.note || "");
  const page = getNotePage(note.page);
  const tags = normalizeTags(note.tags || []);
  const deleteButton = options.canDelete && note.id
    ? `<button class="quote-delete-button" type="button" data-delete-quote="${escapeHtml(note.id)}" data-delete-quote-book="${escapeHtml(options.bookId || "")}">Delete</button>`
    : "";
  const card = `
    <article class="embedded-note quote-card" data-quote-card>
      <div class="quote-card-topline">
        <span>Page ${escapeHtml(page)} &middot; ${formatDate(note.createdAt)}</span>
        ${deleteButton}
      </div>
      <p>${escapeHtml(note.quote || "")}</p>
      ${noteText ? `<small>${escapeHtml(noteText)}</small>` : ""}
      ${tags.length ? `<div class="tag-list">${tags.map((tag) => `<b>#${escapeHtml(tag)}</b>`).join("")}</div>` : ""}
    </article>
  `;

  if (!options.bookId || options.canDelete) return card;

  const href = `reader.html?id=${encodeURIComponent(options.bookId)}&page=${encodeURIComponent(page)}&mode=quotes`;
  return `<a class="quote-card-link" href="${href}">${card}</a>`;
}

function getBookCaptureCounts(books) {
  return books.reduce(
    (totals, book) => {
      totals.pages += book.currentPage || 0;
      totals.notes += captureCount(book, "notes");
      return totals;
    },
    { pages: 0, notes: 0 }
  );
}

async function getDashboardStats(books) {
  try {
    return await getBackendStats();
  } catch (error) {
    console.warn("Backend stats unavailable, using loaded books", error);
  }

  const totals = getBookCaptureCounts(books);
  return {
    books: books.length,
    pagesRead: totals.pages,
    quotes: totals.notes,
  };
}

function renderDashboardHero(books) {
  const title = document.querySelector("[data-hero-title]");
  if (!title) return;

  const status = document.querySelector("[data-hero-status]");
  const meta = document.querySelector("[data-hero-meta]");
  const link = document.querySelector("[data-hero-link]");
  const latest = books[0];

  if (!latest) {
    status.textContent = "Upload a PDF";
    title.textContent = "Your real books will appear here.";
    meta.textContent = "Choose a PDF to create a saved book with its own notes and quotes.";
    if (link) {
      link.href = "shelf.html";
      link.textContent = "Open Shelf";
    }
    return;
  }

  status.textContent = "Notebook ready";
  title.textContent = latest.title;
  meta.textContent = latest.author ? `By ${latest.author}.` : "Open this book to review notes and quotes.";
  if (link) {
    link.href = `reader.html?id=${encodeURIComponent(latest.id)}`;
    link.textContent = "Open Notebook";
  }
}

function renderDashboardStats(stats) {
  const bookCount = document.querySelector("[data-stat-books]");
  const pageCount = document.querySelector("[data-stat-pages]");
  const quoteCount = document.querySelector("[data-stat-quotes]");

  if (bookCount) bookCount.textContent = String(stats.books || 0);
  if (pageCount) pageCount.textContent = String(stats.pagesRead || 0);
  if (quoteCount) quoteCount.textContent = String(stats.quotes || 0);
}

function getAllQuotes(books) {
  return books.flatMap((book) => {
    const notes = Array.isArray(book.notes) ? book.notes : [];
    return notes.map((note) => ({ ...note, bookId: book.id, bookTitle: book.title }));
  }).sort((first, second) => new Date(second.createdAt || 0) - new Date(first.createdAt || 0));
}

function renderRecentQuotes(books) {
  const container = document.querySelector("[data-recent-quotes]");
  if (!container) return;
  const panel = container.closest(".insight-panel");

  const quotes = getAllQuotes(books).slice(0, 3);
  if (!quotes.length) {
    if (panel) panel.hidden = true;
    return;
  }

  if (panel) panel.hidden = false;
  container.innerHTML = quotes.map((quote) => `
    <a class="quote-card-link" href="reader.html?id=${encodeURIComponent(quote.bookId)}&page=${encodeURIComponent(getNotePage(quote.page))}&mode=quotes">
      <article class="embedded-note quote-card">
        <span>${escapeHtml(quote.bookTitle)} &middot; Page ${escapeHtml(getNotePage(quote.page))}</span>
        <p>${escapeHtml(truncateEnd(quote.quote || ""))}</p>
        ${quote.note ? `<small>${escapeHtml(truncateEnd(quote.note))}</small>` : ""}
      </article>
    </a>
  `).join("");
}

function safeFileName(value) {
  return formatTitle(value || "book").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "book";
}

function addPdfLines(doc, lines, state, options = {}) {
  const pageHeight = doc.internal.pageSize.getHeight();
  const fontSize = options.fontSize || 11;
  const lineHeight = options.lineHeight || 16;
  doc.setFont("helvetica", options.fontStyle || "normal");
  doc.setFontSize(fontSize);

  lines.forEach((line) => {
    if (state.y + lineHeight > pageHeight - state.margin) {
      doc.addPage();
      state.y = state.margin;
    }
    doc.text(line, state.margin, state.y);
    state.y += lineHeight;
  });
}

async function exportBookQuotesPdf(book) {
  const notes = Array.isArray(book.notes) ? book.notes : [];
  if (!notes.length) {
    showStatus("No quotes to export for this book.");
    return;
  }

  const JsPdf = await loadJsPdf();
  const doc = new JsPdf({ unit: "pt", format: "letter" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const state = { margin: 54, y: 54 };
  const textWidth = pageWidth - state.margin * 2;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  addPdfLines(doc, doc.splitTextToSize(book.title || "Book Quotes", textWidth), state, {
    fontSize: 18,
    lineHeight: 22,
    fontStyle: "bold",
  });

  if (book.author) {
    addPdfLines(doc, [`By ${book.author}`], state, { fontSize: 11, lineHeight: 18 });
  }
  state.y += 10;

  notes.forEach((note, index) => {
    const tags = normalizeTags(note.tags || []);
    const heading = `Page ${getNotePage(note.page)} - ${formatDate(note.createdAt)}`;
    const quoteLines = doc.splitTextToSize(normalizeCaptureText(note.quote || ""), textWidth);

    addPdfLines(doc, [heading], state, { fontSize: 10, lineHeight: 15, fontStyle: "bold" });
    addPdfLines(doc, quoteLines, state, { fontSize: 11, lineHeight: 16 });

    if (note.note) {
      addPdfLines(doc, doc.splitTextToSize(`Note: ${normalizeCaptureText(note.note)}`, textWidth), state, {
        fontSize: 10,
        lineHeight: 15,
      });
    }

    if (tags.length) {
      addPdfLines(doc, doc.splitTextToSize(`Tags: ${tags.map((tag) => `#${tag}`).join(" ")}`, textWidth), state, {
        fontSize: 10,
        lineHeight: 15,
      });
    }

    if (index < notes.length - 1) state.y += 14;
  });

  doc.save(`${safeFileName(book.title)}-quotes.pdf`);
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

function renderEmptyState(container, message, title = "No uploaded books yet") {
  container.innerHTML = `
    <div class="empty-library">
      <strong>${escapeHtml(title)}</strong>
      <p>${message}</p>
    </div>
  `;
}

async function renderShelf(loadedBooks) {
  const grid = document.querySelector("[data-book-grid]");
  if (!grid) return;

  let books = [];
  try {
    books = loadedBooks || (await getSavedBooks());
  } catch (error) {
    console.error(error);
    renderEmptyState(grid, "The shelf could not load. Refresh the page or restart the server with make run.");
    return;
  }

  if (!books.length) {
    renderEmptyState(grid, "Upload a PDF to create your first real book.");
    fitSidebarText();
    return;
  }

  const filter = getActiveShelfFilter();
  const visibleBooks = sortShelfBooks(
    books.filter((book) => matchesShelfFilter(book, filter)),
    getActiveShelfSort()
  );
  if (!visibleBooks.length) {
    renderEmptyState(grid, "No books match this shelf filter yet.");
    fitSidebarText();
    return;
  }

  grid.innerHTML = visibleBooks.map(createBookCard).join("");
  fitSidebarText();
}

async function renderDashboard(loadedBooks) {
  const list = document.querySelector("[data-dashboard-books]");
  if (!list) return;

  const books = loadedBooks || (await getSavedBooks());
  const stats = await getDashboardStats(books);
  renderDashboardHero(books);
  renderRecentQuotes(books);
  if (!books.length) {
    renderEmptyState(list, "Your uploaded PDFs will appear here with notes and quotes.");
  } else {
    list.innerHTML = books.map(createDashboardBook).join("");
  }

  renderDashboardStats(stats);
  fitSidebarText();
}

async function renderNotes(loadedBooks) {
  const notesColumn = document.querySelector("[data-real-notes]");
  if (!notesColumn) return;

  const saved = loadedBooks || (await getSavedBooks());

  if (!saved.length) {
    renderEmptyState(notesColumn, "Upload a PDF first, then save quotes from the reader.");
  } else {
    notesColumn.innerHTML = saved.map(createNotesBookCard).join("");
  }

  fitSidebarText();
}

async function renderQuotesPage() {
  const title = document.querySelector("[data-quotes-title]");
  const meta = document.querySelector("[data-quotes-meta]");
  const search = document.querySelector("[data-quote-search]");
  const list = document.querySelector("[data-quote-list]");
  const manageButton = document.querySelector("[data-manage-quotes]");
  if (!title || !meta || !search || !list) return;

  const id = new URLSearchParams(window.location.search).get("id");
  if (!id) {
    title.textContent = "Book not selected";
    meta.textContent = "Choose a book from Notes to view its quotes.";
    search.disabled = true;
    renderEmptyState(list, "Open a book from Notes to see its saved quotes.", "Book not selected");
    return;
  }

  const book = await getBook(id);
  if (!book) {
    title.textContent = "Book not found";
    meta.textContent = "This book could not be loaded.";
    search.disabled = true;
    renderEmptyState(list, "Go back to Notes and choose another book.", "Book not found");
    return;
  }

  const notes = Array.isArray(book.notes) ? book.notes : [];
  let manageQuotes = manageButton?.getAttribute("aria-pressed") === "true";
  const renderFilteredQuotes = () => {
    const query = search.value.trim().toLowerCase();
    const filtered = query
      ? notes.filter((note) => {
          const quote = String(note.quote || "").toLowerCase();
          const noteText = String(note.note || "").toLowerCase();
          const tags = normalizeTags(note.tags || []).join(" ").toLowerCase();
          return quote.includes(query) || noteText.includes(query) || tags.includes(query);
        })
      : notes;

    if (!notes.length) {
      renderEmptyState(list, "No quotes saved for this book yet. Open it from Shelf to save passages.", "No quotes yet");
    } else if (!filtered.length) {
      renderEmptyState(list, "No quotes match that keyword.", "No matches");
    } else {
      list.innerHTML = filtered.map((note) => createQuoteCard(note, { bookId: book.id, canDelete: manageQuotes })).join("");
    }
  };

  title.textContent = book.title;
  meta.textContent = `${book.author ? `By ${book.author}. ` : ""}Page ${book.currentPage} of ${book.totalPages}. ${pluralize(notes.length, "quote")}.`;
  search.disabled = !notes.length;
  search.oninput = renderFilteredQuotes;
  if (manageButton) {
    manageButton.onclick = () => {
      manageQuotes = !manageQuotes;
      manageButton.setAttribute("aria-pressed", String(manageQuotes));
      manageButton.classList.toggle("active", manageQuotes);
      manageButton.textContent = manageQuotes ? "Done" : "Manage Quotes";
      renderFilteredQuotes();
    };
  }
  renderFilteredQuotes();
  fitSidebarText();
}

async function refreshCurrentPage() {
  const books = await getSavedBooks();
  await renderDashboard(books);
  await renderShelf(books);
  await renderNotes(books);
  await renderQuotesPage();

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
  let book = null;

  try {
    book = id ? await getBook(id) : null;
  } catch (error) {
    console.error(error);
    message.textContent = "This book could not be loaded. Restart the server with make run, then try again.";
    message.hidden = false;
    showStatus("Reader could not load this book.", "error");
    return;
  }

  if (!book) {
    message.textContent = "Book not found. Return to Shelf and choose an uploaded PDF.";
    return;
  }

  let pdfjs;
  let pdf;
  try {
    pdfjs = await loadPdfJs();
    const buffer = await getBookPdfBuffer(book);
    pdf = await pdfjs.getDocument({ data: buffer }).promise;
  } catch (error) {
    console.error(error);
    message.textContent = "The saved PDF could not be opened. Return to Shelf and try uploading it again.";
    message.hidden = false;
    showStatus("The saved PDF could not be opened.", "error");
    return;
  }
  const requestedPage = Number(params.get("page"));
  let currentPage = Math.min(
    Math.max(Number.isFinite(requestedPage) && requestedPage > 0 ? Math.floor(requestedPage) : book.currentPage || 1, 1),
    pdf.numPages
  );
  let readerMode = params.get("mode") === "quotes" ? "quotes" : "notes";

  const title = document.querySelector("#readerTitle");
  const sidebarTitle = document.querySelector("#readerSidebarTitle");
  const sidebarMeta = document.querySelector("#readerSidebarMeta");
  const pageStatus = document.querySelector("#pageStatus");
  const pageJumpInput = document.querySelector("#pageJumpInput");
  const pageTotal = document.querySelector("#pageTotal");
  const progressStatus = document.querySelector("#progressStatus");
  const progressBar = document.querySelector("#readerProgressBar");
  const prev = document.querySelector("#prevPage");
  const next = document.querySelector("#nextPage");
  const zoomOut = document.querySelector("#zoomOut");
  const zoomIn = document.querySelector("#zoomIn");
  const zoomStatus = document.querySelector("#zoomStatus");
  const quotesLink = document.querySelector("#readerQuotesLink");
  const noteForm = document.querySelector("[data-note-form]");
  const modeButtons = document.querySelectorAll("[data-reader-mode]");
  const pageQuotesPanel = document.querySelector("[data-page-quotes-panel]");
  const pageQuotesList = document.querySelector("[data-reader-page-quotes]");
  const textLayer = document.querySelector("#textLayer");
  const textLayerStatus = document.querySelector("#textLayerStatus");
  const saveSelectedQuote = document.querySelector("#saveSelectedQuote");
  const context = canvas.getContext("2d");
  const pdfFrame = canvas.parentElement;
  const pdfStage = canvas.closest(".pdf-stage");
  let zoomLevel = 1;
  let lastPinchDistance = null;
  let currentSelectedQuote = "";

  title.textContent = book.title;
  sidebarTitle.textContent = book.title;
  if (quotesLink) quotesLink.href = `quotes.html?id=${encodeURIComponent(book.id)}`;
  fitSidebarText();

  function updateReaderUrl() {
    const nextParams = new URLSearchParams(window.location.search);
    nextParams.set("id", book.id);
    nextParams.set("page", String(currentPage));
    nextParams.set("mode", readerMode);
    window.history.replaceState({}, "", `${window.location.pathname}?${nextParams.toString()}`);
  }

  function renderPageQuotes() {
    if (!pageQuotesList) return;

    const notes = Array.isArray(book.notes) ? book.notes : [];
    const pageNotes = notes.filter((note) => getNotePage(note.page) === currentPage);
    if (!pageNotes.length) {
      renderEmptyState(pageQuotesList, "No quotes saved on this page yet.", "No page quotes");
      return;
    }

    pageQuotesList.innerHTML = pageNotes.map((note) => createQuoteCard(note, {
      bookId: book.id,
      canDelete: true,
    })).join("");
  }

  window.addEventListener("reading-tracker:quote-deleted", (event) => {
    const { bookId, quoteId } = event.detail || {};
    if (String(bookId) !== String(book.id) || !quoteId) return;
    if (Array.isArray(book.notes)) {
      book.notes = book.notes.filter((note) => String(note.id) !== String(quoteId));
    }
    renderPageQuotes();
  });

  function setReaderMode(mode) {
    readerMode = mode === "quotes" ? "quotes" : "notes";
    modeButtons.forEach((button) => {
      const active = button.dataset.readerMode === readerMode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    if (noteForm) {
      const hideNotes = readerMode !== "notes";
      noteForm.hidden = hideNotes;
      noteForm.setAttribute("aria-hidden", String(hideNotes));
    }
    if (pageQuotesPanel) {
      const hideQuotes = readerMode !== "quotes";
      pageQuotesPanel.hidden = hideQuotes;
      pageQuotesPanel.setAttribute("aria-hidden", String(hideQuotes));
    }
    if (readerMode === "quotes") renderPageQuotes();
    updateReaderUrl();
  }

  async function renderPageToCanvas(page, targetCanvas, targetContext, scale) {
    const viewport = page.getViewport({ scale });
    targetCanvas.width = viewport.width;
    targetCanvas.height = viewport.height;
    await page.render({ canvasContext: targetContext, viewport }).promise;
    return viewport;
  }

  function clearTextLayer() {
    textLayer.innerHTML = "";
    textLayer.style.width = `${canvas.width}px`;
    textLayer.style.height = `${canvas.height}px`;
    pdfFrame.style.width = `${canvas.width}px`;
    pdfFrame.style.height = `${canvas.height}px`;
    currentSelectedQuote = "";
    saveSelectedQuote.hidden = true;
  }

  function setTextLayerStatus(value) {
    textLayerStatus.textContent = value;
  }

  function getSelectedQuoteFromLayer() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return "";
    const range = selection.getRangeAt(0);
    if (!textLayer.contains(range.commonAncestorContainer)) return "";
    return normalizeCaptureText(selection.toString());
  }

  function refreshSelectionAction() {
    currentSelectedQuote = getSelectedQuoteFromLayer();
    saveSelectedQuote.hidden = !currentSelectedQuote;
    if (currentSelectedQuote && noteForm && document.activeElement !== noteForm.elements.quote) {
      noteForm.elements.quote.value = currentSelectedQuote;
    }
    if (currentSelectedQuote) {
      setTextLayerStatus("Selected text copied to the quote box.");
    }
  }

  function appendTextSpan(text, left, top, width, height, angle = 0) {
    const span = document.createElement("span");
    span.textContent = text;
    span.style.left = `${left}px`;
    span.style.top = `${top}px`;
    span.style.width = `${Math.max(width, 1)}px`;
    span.style.height = `${Math.max(height, 1)}px`;
    span.style.fontSize = `${Math.max(height, 1)}px`;
    span.style.transform = angle ? `rotate(${angle}rad)` : "";
    textLayer.append(span);
  }

  async function renderPdfTextLayer(page, viewport) {
    const textContent = await page.getTextContent();
    const items = textContent.items.filter((item) => normalizeCaptureText(item.str || ""));
    const meaningfulText = normalizeCaptureText(items.map((item) => item.str).join(" "));
    if (meaningfulText.length < 8) return false;

    items.forEach((item) => {
      const transform = pdfjs.Util.transform(viewport.transform, item.transform);
      const angle = Math.atan2(transform[1], transform[0]);
      const fontHeight = Math.hypot(transform[2], transform[3]) || Math.hypot(transform[0], transform[1]) || 12;
      const width = Math.max((item.width || item.str.length * fontHeight * 0.45) * viewport.scale, fontHeight);
      appendTextSpan(item.str, transform[4], transform[5] - fontHeight, width, fontHeight, angle);
    });

    return true;
  }

  function renderOcrTextLayer(words) {
    const width = canvas.width;
    const height = canvas.height;
    words.forEach((word) => {
      if (!word.text) return;
      appendTextSpan(
        word.text,
        word.x0 * width,
        word.y0 * height,
        (word.x1 - word.x0) * width,
        (word.y1 - word.y0) * height
      );
    });
  }

  async function runOcrForPage(pageNumber) {
    const cached = readOcrCache(book.id, pageNumber);
    if (cached?.length) {
      renderOcrTextLayer(cached);
      setTextLayerStatus("Selectable text from OCR cache.");
      return true;
    }

    setTextLayerStatus("Reading page text with OCR...");
    const Tesseract = await loadTesseract();
    const result = await Tesseract.recognize(canvas, "eng");
    const sourceWords = result?.data?.words || [];
    const words = sourceWords
      .filter((word) => word.bbox)
      .map((word) => ({
        text: normalizeCaptureText(word.text || ""),
        x0: word.bbox.x0 / canvas.width,
        y0: word.bbox.y0 / canvas.height,
        x1: word.bbox.x1 / canvas.width,
        y1: word.bbox.y1 / canvas.height,
      }))
      .filter((word) => word.text && word.x1 > word.x0 && word.y1 > word.y0);

    if (!words.length) return false;
    writeOcrCache(book.id, pageNumber, words);
    renderOcrTextLayer(words);
    setTextLayerStatus("Selectable text from OCR.");
    return true;
  }

  async function renderSelectableText(page, viewport, pageNumber) {
    clearTextLayer();
    setTextLayerStatus("Preparing selectable text...");

    try {
      if (await renderPdfTextLayer(page, viewport)) {
        setTextLayerStatus("Selectable text ready.");
        return;
      }

      if (await runOcrForPage(pageNumber)) return;
      setTextLayerStatus("No selectable text found. Use the quote box manually.");
    } catch (error) {
      console.warn("Selectable text could not be prepared", error);
      setTextLayerStatus("Text selection unavailable. Use the quote box manually.");
    }
  }

  async function drawPage(pageNumber) {
    currentPage = Math.min(Math.max(Math.floor(Number(pageNumber) || 1), 1), pdf.numPages);
    message.hidden = true;
    const page = await pdf.getPage(currentPage);
    const baseViewport = page.getViewport({ scale: 1 });
    const stageRect = pdfStage.getBoundingClientRect();
    const maxWidth = stageRect.width - 24;
    const maxHeight = Math.min(stageRect.height - 24, window.innerHeight - stageRect.top - 24);
    const fitScale = Math.min(maxWidth / baseViewport.width, maxHeight / baseViewport.height);
    const scale = fitScale * zoomLevel;

    const viewport = await renderPageToCanvas(page, canvas, context, scale);
    await renderSelectableText(page, viewport, currentPage);

    const percent = Math.round((currentPage / pdf.numPages) * 100);
    if (pageJumpInput && document.activeElement !== pageJumpInput) {
      pageJumpInput.value = String(currentPage);
    }
    if (pageJumpInput) {
      pageJumpInput.max = String(pdf.numPages);
    }
    if (pageTotal) pageTotal.textContent = String(pdf.numPages);
    progressStatus.textContent = `${percent}% through this PDF`;
    progressBar.style.width = `${percent}%`;
    sidebarMeta.textContent = `${book.author ? `By ${book.author}. ` : ""}Page ${currentPage} of ${pdf.numPages}`;
    zoomStatus.textContent = `${Math.round(zoomLevel * 100)}%`;
    prev.disabled = currentPage <= 1;
    next.disabled = currentPage >= pdf.numPages;
    renderPageQuotes();
    updateReaderUrl();
    await updateBookPage(book.id, currentPage);
  }

  async function setZoom(nextZoom) {
    const previousZoom = zoomLevel;
    zoomLevel = Math.min(Math.max(nextZoom, 0.75), 2.5);
    if (Math.abs(previousZoom - zoomLevel) < 0.01) return;
    await drawPage(currentPage);
  }

  async function goToPreviousPage() {
    if (currentPage <= 1) return;
    currentPage = Math.max(1, currentPage - 1);
    await drawPage(currentPage);
  }

  async function goToNextPage() {
    if (currentPage >= pdf.numPages) return;
    currentPage = Math.min(pdf.numPages, currentPage + 1);
    await drawPage(currentPage);
  }

  async function jumpToTypedPage() {
    if (!pageJumpInput) return;
    const pageNumber = Math.min(Math.max(Math.floor(Number(pageJumpInput.value) || currentPage), 1), pdf.numPages);
    pageJumpInput.value = String(pageNumber);
    await drawPage(pageNumber);
  }

  prev.addEventListener("click", goToPreviousPage);
  next.addEventListener("click", goToNextPage);
  pageJumpInput?.addEventListener("change", jumpToTypedPage);
  pageJumpInput?.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    await jumpToTypedPage();
  });
  zoomOut?.addEventListener("click", () => setZoom(zoomLevel - 0.15));
  zoomIn?.addEventListener("click", () => setZoom(zoomLevel + 0.15));
  modeButtons.forEach((button) => {
    button.addEventListener("click", () => setReaderMode(button.dataset.readerMode));
  });

  pdfStage.addEventListener(
    "wheel",
    async (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      await setZoom(zoomLevel + (event.deltaY < 0 ? 0.12 : -0.12));
    },
    { passive: false }
  );

  pdfStage.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length !== 2) return;
      const [first, second] = event.touches;
      lastPinchDistance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
    },
    { passive: false }
  );

  pdfStage.addEventListener(
    "touchmove",
    async (event) => {
      if (event.touches.length !== 2 || !lastPinchDistance) return;
      event.preventDefault();
      const [first, second] = event.touches;
      const distance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
      await setZoom(zoomLevel * (distance / lastPinchDistance));
      lastPinchDistance = distance;
    },
    { passive: false }
  );

  pdfStage.addEventListener("touchend", () => {
    lastPinchDistance = null;
  });

  document.addEventListener("selectionchange", refreshSelectionAction);
  textLayer.addEventListener("mouseup", refreshSelectionAction);
  textLayer.addEventListener("keyup", refreshSelectionAction);

  saveSelectedQuote.addEventListener("click", async () => {
    const quote = currentSelectedQuote || getSelectedQuoteFromLayer() || normalizeCaptureText(noteForm.elements.quote.value);
    if (!quote) return;

    noteForm.elements.quote.value = quote;
    const note = normalizeCaptureText(noteForm.elements.note.value);
    const tags = normalizeTags(noteForm.elements.tags?.value || "");
    const saved = await addBookCapture(book.id, "notes", { quote, note, tags, page: currentPage });
    if (saved) {
      if (!Array.isArray(book.notes)) book.notes = [];
      book.notes = [saved, ...book.notes.filter((entry) => entry.id !== saved.id)];
    }
    noteForm.reset();
    window.getSelection()?.removeAllRanges();
    refreshSelectionAction();
    setTextLayerStatus("Quote saved.");
    renderPageQuotes();
    await refreshCurrentPage();
  });

  document.addEventListener("keydown", async (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const editable = event.target.closest("input, textarea, select, [contenteditable='true']");
    if (editable) return;

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      await goToPreviousPage();
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      await goToNextPage();
    }
  });

  noteForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const quote = normalizeCaptureText(noteForm.elements.quote.value) || currentSelectedQuote || getSelectedQuoteFromLayer();
    const note = normalizeCaptureText(noteForm.elements.note.value);
    const tags = normalizeTags(noteForm.elements.tags?.value || "");
    if (!quote) return;

    const saved = await addBookCapture(book.id, "notes", { quote, note, tags, page: currentPage });
    if (saved) {
      if (!Array.isArray(book.notes)) book.notes = [];
      book.notes = [saved, ...book.notes.filter((entry) => entry.id !== saved.id)];
    }
    noteForm.reset();
    window.getSelection()?.removeAllRanges();
    refreshSelectionAction();
    setTextLayerStatus("Quote saved.");
    renderPageQuotes();
    await refreshCurrentPage();
  });

  window.addEventListener("resize", () => {
    window.clearTimeout(window.readerResizeTimer);
    window.readerResizeTimer = window.setTimeout(() => drawPage(currentPage), 180);
  });

  setReaderMode(readerMode);
  await drawPage(currentPage);
}

async function init() {
  bindUploadButtons();
  bindRenameControls();
  bindNotesTools();
  bindShelfFilters();
  const books = await getSavedBooks();
  try {
    await renderDashboard(books);
    await renderShelf(books);
    await renderNotes(books);
    await renderQuotesPage();
    await renderReader();
  } catch (error) {
    console.error(error);
    throw error;
  }
  fitSidebarText();
}

init().catch((error) => {
  console.error(error);
  showStatus("Reading Notebook could not start. Refresh the page or restart the server with make run.", "error");
});
