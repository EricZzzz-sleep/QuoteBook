const DB_NAME = "reading-tracker";
const DB_VERSION = 1;
const BOOK_STORE = "books";
const DEFAULT_API_BASE_URL = window.location.protocol === "file:" ? "http://localhost:8000" : window.location.origin;
const API_BASE_URL = window.READING_TRACKER_API_URL || DEFAULT_API_BASE_URL;
const PDF_JS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";
const PDF_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";
const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
const JSPDF_URL = "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js";
const STUDY_STATUSES = new Set(["new", "learning", "mastered"]);
const STUDY_DAILY_GOAL_KEY = "quotebook-study-daily-pages-goal";
const STUDY_FINISH_GOALS_KEY = "quotebook-study-finish-goals";

let dbPromise;
let uploadInProgress = false;
let storagePersistencePromise;
let tesseractPromise;
let jsPdfPromise;
let deferredInstallPrompt;

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

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch((error) => {
      console.warn("Service worker could not be registered", error);
    });
  });
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
  const previousPage = Number(book.currentPage || 1);
  book.currentPage = currentPage;
  const now = new Date().toISOString();
  book.lastReadAt = now;
  book.updatedAt = now;
  const dates = Array.isArray(book.readingDates) ? book.readingDates : [];
  const today = todayKey();
  book.readingDates = dates.includes(today) ? dates : [...dates, today];
  if (currentPage > previousPage) {
    mergeLocalReadingActivity(book, { date: today, pagesRead: currentPage - previousPage });
  }
  await saveBook(book);
}

async function recordReadingActivity(id, activity) {
  const normalized = normalizeActivityDelta(activity);
  if (!normalized.secondsRead && !normalized.pagesRead && !normalized.quotesSaved) return null;

  try {
    const response = await apiRequest(`/api/books/${encodeURIComponent(id)}/activity/`, {
      method: "POST",
      body: JSON.stringify(normalized),
    });
    return response.book || null;
  } catch (error) {
    console.warn("Backend unavailable, saving reading activity locally", error);
  }

  const book = await getBook(id);
  if (!book) return null;
  mergeLocalReadingActivity(book, normalized);
  const now = new Date().toISOString();
  book.lastReadAt = now;
  book.updatedAt = now;
  const dates = Array.isArray(book.readingDates) ? book.readingDates : [];
  book.readingDates = dates.includes(normalized.date) ? dates : [...dates, normalized.date].sort();
  await saveBook(book);
  return book;
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
  if (type === "notes") normalizeStudyCard(capture);

  if (!Array.isArray(book[type])) book[type] = [];
  book[type].unshift(capture);
  if (type === "notes") {
    mergeLocalReadingActivity(book, { date: todayKey(), quotesSaved: 1 });
  }
  book.updatedAt = new Date().toISOString();
  await saveBook(book);
  return capture;
}

async function updateBookQuoteReview(bookId, quoteId, status) {
  const nextStatus = STUDY_STATUSES.has(status) ? status : "learning";
  try {
    const response = await apiRequest(`/api/books/${encodeURIComponent(bookId)}/captures/${encodeURIComponent(quoteId)}/`, {
      method: "PATCH",
      body: JSON.stringify({ status: nextStatus }),
    });
    return response.book || null;
  } catch (error) {
    console.warn("Backend unavailable, updating quote review locally", error);
  }

  const book = await getBook(bookId);
  if (!book) return null;
  const notes = Array.isArray(book.notes) ? book.notes : [];
  const now = new Date().toISOString();
  book.notes = notes.map((note) => {
    if (String(note.id) !== String(quoteId)) return note;
    const updated = normalizeStudyCard({ ...note });
    updated.status = nextStatus;
    updated.reviewCount = Number(updated.reviewCount || 0) + 1;
    updated.lastReviewedAt = now;
    updated.masteredAt = nextStatus === "mastered" ? now : "";
    return updated;
  });
  book.updatedAt = now;
  await saveBook(book);
  return book;
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

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseNonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizeActivityDelta(activity = {}) {
  return {
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(activity.date || "")) ? activity.date : todayKey(),
    secondsRead: parseNonNegativeInteger(activity.secondsRead),
    pagesRead: parseNonNegativeInteger(activity.pagesRead),
    quotesSaved: parseNonNegativeInteger(activity.quotesSaved),
  };
}

function normalizeReadingActivityEntry(entry = {}) {
  return {
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(entry.date || "")) ? entry.date : "",
    secondsRead: parseNonNegativeInteger(entry.secondsRead),
    pagesRead: parseNonNegativeInteger(entry.pagesRead),
    quotesSaved: parseNonNegativeInteger(entry.quotesSaved),
  };
}

function mergeLocalReadingActivity(book, activity) {
  const delta = normalizeActivityDelta(activity);
  const entries = Array.isArray(book.readingActivity) ? book.readingActivity : [];
  const nextEntry = { date: delta.date, secondsRead: 0, pagesRead: 0, quotesSaved: 0 };
  const nextEntries = [];

  entries.forEach((entry) => {
    const normalized = normalizeReadingActivityEntry(entry);
    if (!normalized.date) return;
    if (normalized.date === delta.date) {
      nextEntry.secondsRead += normalized.secondsRead;
      nextEntry.pagesRead += normalized.pagesRead;
      nextEntry.quotesSaved += normalized.quotesSaved;
      return;
    }
    nextEntries.push(normalized);
  });

  nextEntry.secondsRead += delta.secondsRead;
  nextEntry.pagesRead += delta.pagesRead;
  nextEntry.quotesSaved += delta.quotesSaved;
  nextEntries.push(nextEntry);
  book.readingActivity = nextEntries.sort((first, second) => first.date.localeCompare(second.date));
}

function getDailyPageGoal() {
  try {
    return parseNonNegativeInteger(localStorage.getItem(STUDY_DAILY_GOAL_KEY), 20);
  } catch (error) {
    console.warn("Daily goal could not be read", error);
    return 20;
  }
}

function saveDailyPageGoal(value) {
  const goal = Math.min(Math.max(parseNonNegativeInteger(value, 20), 1), 999);
  try {
    localStorage.setItem(STUDY_DAILY_GOAL_KEY, String(goal));
  } catch (error) {
    console.warn("Daily goal could not be saved", error);
  }
  return goal;
}

function getFinishGoals() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STUDY_FINISH_GOALS_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.warn("Finish goals could not be read", error);
    return {};
  }
}

function saveFinishGoal(bookId, finishDate) {
  const goals = getFinishGoals();
  if (finishDate) goals[bookId] = finishDate;
  else delete goals[bookId];
  try {
    localStorage.setItem(STUDY_FINISH_GOALS_KEY, JSON.stringify(goals));
  } catch (error) {
    console.warn("Finish goal could not be saved", error);
  }
  return goals;
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

function normalizeStudyCard(note) {
  const reviewCount = Number(note.reviewCount || 0);
  note.status = STUDY_STATUSES.has(note.status) ? note.status : "new";
  note.reviewCount = Number.isFinite(reviewCount) && reviewCount > 0 ? Math.floor(reviewCount) : 0;
  note.lastReviewedAt = note.lastReviewedAt || "";
  note.masteredAt = note.status === "mastered" ? note.masteredAt || note.lastReviewedAt || "" : "";
  return note;
}

function getQuoteStatus(note) {
  return normalizeStudyCard({ ...note }).status;
}

function getStudyQuotes(books) {
  return books.flatMap((book) => {
    const notes = Array.isArray(book.notes) ? book.notes : [];
    return notes.map((note) => normalizeStudyCard({
      ...note,
      bookId: book.id,
      bookTitle: book.title,
      bookAuthor: book.author || "",
    }));
  });
}

function sortStudyQueue(quotes) {
  const statusWeight = { new: 0, learning: 1, mastered: 2 };
  return [...quotes].sort((first, second) => {
    const firstStatus = statusWeight[getQuoteStatus(first)] ?? 0;
    const secondStatus = statusWeight[getQuoteStatus(second)] ?? 0;
    if (firstStatus !== secondStatus) return firstStatus - secondStatus;
    return new Date(first.lastReviewedAt || first.createdAt || 0) - new Date(second.lastReviewedAt || second.createdAt || 0);
  });
}

function getThemeGroups(quotes) {
  const groups = new Map();
  quotes.forEach((quote) => {
    normalizeTags(quote.tags || []).forEach((tag) => {
      const key = tag.toLowerCase();
      if (!groups.has(key)) {
        groups.set(key, { tag, quotes: [] });
      }
      groups.get(key).quotes.push(quote);
    });
  });
  return Array.from(groups.values()).sort((first, second) => second.quotes.length - first.quotes.length || first.tag.localeCompare(second.tag));
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
    readingActivity: [],
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

function getShelfSearchQuery() {
  return normalizeCaptureText(document.querySelector("[data-shelf-search]")?.value || "").toLowerCase();
}

function getActiveShelfSort() {
  return document.querySelector("[data-shelf-sort]")?.value || "recent";
}

function matchesShelfSearch(book, query) {
  if (!query) return true;

  const searchableText = [
    book.title,
    book.author,
    book.fileName,
    book.cover,
  ].map((value) => normalizeCaptureText(String(value || "")).toLowerCase()).join(" ");

  return searchableText.includes(query);
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
  document.addEventListener("change", async (event) => {
    if (!event.target.matches("[data-shelf-sort]")) return;
    await renderShelf();
  });

  document.addEventListener("input", async (event) => {
    if (!event.target.matches("[data-shelf-search]")) return;
    await renderShelf();
  });
}

function bindInstallPrompt() {
  const installButton = document.querySelector("[data-install-app]");
  if (!installButton) return;

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    installButton.hidden = false;
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    installButton.hidden = true;
    showStatus("QuoteBook was installed.");
  });

  installButton.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installButton.hidden = true;
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

function bindStudyTools() {
  document.addEventListener("click", async (event) => {
    const reviewButton = event.target.closest("[data-review-status]");
    if (reviewButton) {
      event.preventDefault();
      await updateBookQuoteReview(reviewButton.dataset.reviewBook, reviewButton.dataset.reviewQuote, reviewButton.dataset.reviewStatus);
      showStatus("Study card updated.");
      await renderStudy();
      return;
    }

    const themeButton = event.target.closest("[data-study-theme]");
    if (themeButton) {
      event.preventDefault();
      const params = new URLSearchParams(window.location.search);
      params.set("theme", themeButton.dataset.studyTheme);
      window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);
      await renderStudy();
      return;
    }

    const exportButton = event.target.closest("[data-export-study]");
    if (!exportButton) return;
    event.preventDefault();

    const books = await getSavedBooks();
    const quotes = getStudyQuotes(books);
    const theme = exportButton.dataset.exportTheme;
    const bookId = exportButton.dataset.exportBook;
    const exportQuotes = theme
      ? quotes.filter((quote) => normalizeTags(quote.tags || []).some((tag) => tag.toLowerCase() === theme.toLowerCase()))
      : bookId
        ? quotes.filter((quote) => String(quote.bookId) === String(bookId))
        : quotes;
    const book = bookId ? books.find((entry) => String(entry.id) === String(bookId)) : null;
    const title = theme
      ? `QuoteBook Study Theme: #${theme}`
      : book
        ? `QuoteBook Study Notes: ${book.title}`
        : "QuoteBook Study Notes";
    const fileName = safeFileName(theme
      ? `study-${theme}`
      : book
        ? `study-${book.title}`
        : "study-notes");

    try {
      if (exportButton.dataset.exportStudy === "pdf") {
        await exportStudyQuotesPdf(exportQuotes, title, `${fileName}.pdf`);
      } else {
        downloadTextFile(`${fileName}.md`, getStudyExportRows(exportQuotes, title));
      }
      showStatus("Study notes exported.");
    } catch (error) {
      console.error(error);
      showStatus("Study notes could not be exported.", "error");
    }
  });

  document.addEventListener("submit", async (event) => {
    const dailyGoalForm = event.target.closest("[data-daily-goal-form]");
    if (dailyGoalForm) {
      event.preventDefault();
      saveDailyPageGoal(dailyGoalForm.elements.dailyGoal.value);
      showStatus("Daily reading goal saved.");
      await renderStudy();
      return;
    }

    const finishGoalForm = event.target.closest("[data-finish-goal-form]");
    if (!finishGoalForm) return;
    event.preventDefault();
    saveFinishGoal(finishGoalForm.dataset.bookId, finishGoalForm.elements.finishDate.value);
    showStatus("Finish goal saved.");
    await renderStudy();
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
  const status = getQuoteStatus(note);
  const deleteButton = options.canDelete && note.id
    ? `<button class="quote-delete-button" type="button" data-delete-quote="${escapeHtml(note.id)}" data-delete-quote-book="${escapeHtml(options.bookId || "")}">Delete</button>`
    : "";
  const card = `
    <article class="embedded-note quote-card" data-quote-card>
      <div class="quote-card-topline">
        <span>Page ${escapeHtml(page)} &middot; ${formatDate(note.createdAt)}</span>
        <b class="study-status status-${escapeHtml(status)}">${escapeHtml(status)}</b>
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

function getBookActivity(book) {
  const activity = Array.isArray(book.readingActivity) ? book.readingActivity : [];
  const normalized = activity
    .map(normalizeReadingActivityEntry)
    .filter((entry) => entry.date);
  const activityDates = new Set(normalized.map((entry) => entry.date));

  getReadingDates(book).forEach((date) => {
    if (!activityDates.has(date)) {
      normalized.push({ date, secondsRead: 0, pagesRead: 0, quotesSaved: 0 });
    }
  });

  return normalized.sort((first, second) => first.date.localeCompare(second.date));
}

function getDailyStudyRows(books, days = 7) {
  const today = todayKey();
  const start = addDays(today, -(days - 1));
  const rows = new Map();
  for (let index = 0; index < days; index += 1) {
    const date = addDays(start, index);
    rows.set(date, { date, secondsRead: 0, pagesRead: 0, quotesSaved: 0, books: new Set() });
  }

  books.forEach((book) => {
    getBookActivity(book).forEach((entry) => {
      if (!rows.has(entry.date)) return;
      const row = rows.get(entry.date);
      row.secondsRead += entry.secondsRead;
      row.pagesRead += entry.pagesRead;
      row.quotesSaved += entry.quotesSaved;
      if (entry.secondsRead || entry.pagesRead || entry.quotesSaved) row.books.add(book.title);
    });
  });

  return Array.from(rows.values()).map((row) => ({
    ...row,
    books: Array.from(row.books),
  }));
}

function getBookActivityTotals(book) {
  return getBookActivity(book).reduce(
    (total, entry) => ({
      secondsRead: total.secondsRead + entry.secondsRead,
      pagesRead: total.pagesRead + entry.pagesRead,
      quotesSaved: total.quotesSaved + entry.quotesSaved,
    }),
    { secondsRead: 0, pagesRead: 0, quotesSaved: 0 }
  );
}

function formatReadingTime(seconds) {
  const totalMinutes = Math.floor(Number(seconds || 0) / 60);
  if (totalMinutes < 1) return seconds ? "<1 min" : "0 min";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${minutes} min`;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatShortDate(dateKey) {
  const date = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateKey;
  return new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric" }).format(date);
}

function getTodayStudyStats(books) {
  const today = todayKey();
  return getDailyStudyRows(books, 1).find((row) => row.date === today) || {
    date: today,
    secondsRead: 0,
    pagesRead: 0,
    quotesSaved: 0,
    books: [],
  };
}

function getFinishGoalPlan(book, finishGoals) {
  const finishDate = finishGoals[String(book.id)] || "";
  const remainingPages = Math.max(Number(book.totalPages || 0) - Number(book.currentPage || 1), 0);
  if (!finishDate) {
    return { finishDate: "", remainingPages, daysLeft: null, pagesPerDay: null, message: "Set a finish date to calculate pace." };
  }

  const today = new Date(`${todayKey()}T00:00:00`);
  const deadline = new Date(`${finishDate}T00:00:00`);
  const daysLeft = Math.max(Math.ceil((deadline - today) / 86400000) + 1, 1);
  const pagesPerDay = remainingPages ? Math.ceil(remainingPages / daysLeft) : 0;
  const message = remainingPages
    ? `${pagesPerDay} pages/day to finish by ${formatShortDate(finishDate)}`
    : "Finished already.";
  return { finishDate, remainingPages, daysLeft, pagesPerDay, message };
}

function createActivityBar(row, maxPages, dailyGoal) {
  const pageWidth = Math.min((row.pagesRead / Math.max(maxPages, dailyGoal, 1)) * 100, 100);
  const quoteLabel = row.quotesSaved ? ` &middot; ${pluralize(row.quotesSaved, "quote")}` : "";
  return `
    <article class="activity-row">
      <div>
        <strong>${escapeHtml(formatShortDate(row.date))}</strong>
        <span>${escapeHtml(formatReadingTime(row.secondsRead))}${quoteLabel}</span>
      </div>
      <div class="activity-meter" aria-hidden="true"><span style="width: ${pageWidth}%"></span></div>
      <b>${row.pagesRead}</b>
    </article>
  `;
}

function createBookGoalRow(book, finishGoals) {
  const totals = getBookActivityTotals(book);
  const plan = getFinishGoalPlan(book, finishGoals);
  return `
    <article class="book-goal-row">
      ${createCoverMarkup(book)}
      <div>
        <h3>${escapeHtml(book.title)}</h3>
        <p>Page ${escapeHtml(book.currentPage || 1)} of ${escapeHtml(book.totalPages || 1)} &middot; ${escapeHtml(plan.message)}</p>
        <span>${escapeHtml(formatReadingTime(totals.secondsRead))} tracked &middot; ${escapeHtml(pluralize(totals.pagesRead, "page"))} &middot; ${escapeHtml(pluralize(totals.quotesSaved || captureCount(book, "notes"), "quote"))}</span>
      </div>
      <form class="goal-date-form" data-finish-goal-form data-book-id="${escapeHtml(book.id)}">
        <input type="date" name="finishDate" value="${escapeHtml(plan.finishDate)}" min="${escapeHtml(todayKey())}" aria-label="Finish date for ${escapeHtml(book.title)}">
        <button class="ghost-action" type="submit">Set</button>
      </form>
    </article>
  `;
}

function getStudyExportRows(quotes, title) {
  const lines = [`# ${title}`, ""];
  quotes.forEach((quote) => {
    const tags = normalizeTags(quote.tags || []);
    lines.push(`## ${quote.bookTitle} - Page ${getNotePage(quote.page)}`);
    lines.push("");
    lines.push(`> ${normalizeCaptureText(quote.quote || "")}`);
    if (quote.note) {
      lines.push("");
      lines.push(`Note: ${normalizeCaptureText(quote.note)}`);
    }
    if (tags.length) {
      lines.push("");
      lines.push(`Tags: ${tags.map((tag) => `#${tag}`).join(" ")}`);
    }
    lines.push("");
  });
  return lines.join("\n");
}

function downloadTextFile(fileName, text, type = "text/markdown") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function exportStudyQuotesPdf(quotes, title, fileName) {
  if (!quotes.length) {
    showStatus("No study notes to export.");
    return;
  }

  const JsPdf = await loadJsPdf();
  const doc = new JsPdf({ unit: "pt", format: "letter" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const state = { margin: 54, y: 54 };
  const textWidth = pageWidth - state.margin * 2;

  addPdfLines(doc, doc.splitTextToSize(title, textWidth), state, { fontSize: 18, lineHeight: 22, fontStyle: "bold" });
  state.y += 10;

  quotes.forEach((quote, index) => {
    const tags = normalizeTags(quote.tags || []);
    addPdfLines(doc, [`${quote.bookTitle} - Page ${getNotePage(quote.page)}`], state, { fontSize: 10, lineHeight: 15, fontStyle: "bold" });
    addPdfLines(doc, doc.splitTextToSize(normalizeCaptureText(quote.quote || ""), textWidth), state, { fontSize: 11, lineHeight: 16 });
    if (quote.note) {
      addPdfLines(doc, doc.splitTextToSize(`Note: ${normalizeCaptureText(quote.note)}`, textWidth), state, { fontSize: 10, lineHeight: 15 });
    }
    if (tags.length) {
      addPdfLines(doc, doc.splitTextToSize(`Tags: ${tags.map((tag) => `#${tag}`).join(" ")}`, textWidth), state, { fontSize: 10, lineHeight: 15 });
    }
    if (index < quotes.length - 1) state.y += 14;
  });

  doc.save(fileName);
}

function createStudyReviewCard(quote) {
  const tags = normalizeTags(quote.tags || []);
  return `
    <article class="study-review-card">
      <div class="quote-card-topline">
        <span>${escapeHtml(quote.bookTitle)} &middot; Page ${escapeHtml(getNotePage(quote.page))}</span>
        <b class="study-status status-${escapeHtml(getQuoteStatus(quote))}">${escapeHtml(getQuoteStatus(quote))}</b>
      </div>
      <p>${escapeHtml(quote.quote || "")}</p>
      ${quote.note ? `<small>${escapeHtml(quote.note)}</small>` : ""}
      ${tags.length ? `<div class="tag-list">${tags.map((tag) => `<b>#${escapeHtml(tag)}</b>`).join("")}</div>` : ""}
      <div class="study-review-actions">
        <button class="ghost-action" type="button" data-review-status="new" data-review-book="${escapeHtml(quote.bookId)}" data-review-quote="${escapeHtml(quote.id)}">Again</button>
        <button class="ghost-action" type="button" data-review-status="learning" data-review-book="${escapeHtml(quote.bookId)}" data-review-quote="${escapeHtml(quote.id)}">Good</button>
        <button class="primary-action" type="button" data-review-status="mastered" data-review-book="${escapeHtml(quote.bookId)}" data-review-quote="${escapeHtml(quote.id)}">Mastered</button>
        <a class="ghost-action link-action" href="reader.html?id=${encodeURIComponent(quote.bookId)}&page=${encodeURIComponent(getNotePage(quote.page))}&mode=quotes">Open page</a>
      </div>
    </article>
  `;
}

function createThemeCard(group, selectedTheme) {
  const active = selectedTheme === group.tag.toLowerCase();
  return `
    <button class="theme-chip ${active ? "active" : ""}" type="button" data-study-theme="${escapeHtml(group.tag.toLowerCase())}">
      <span>#${escapeHtml(group.tag)}</span>
      <strong>${group.quotes.length}</strong>
    </button>
  `;
}

function createStudyQuoteItem(quote) {
  const tags = normalizeTags(quote.tags || []);
  return `
    <article class="study-quote-item">
      <div class="quote-card-topline">
        <span>${escapeHtml(quote.bookTitle)} &middot; Page ${escapeHtml(getNotePage(quote.page))}</span>
        <b class="study-status status-${escapeHtml(getQuoteStatus(quote))}">${escapeHtml(getQuoteStatus(quote))}</b>
      </div>
      <p>${escapeHtml(quote.quote || "")}</p>
      ${quote.note ? `<small>${escapeHtml(quote.note)}</small>` : ""}
      ${tags.length ? `<div class="tag-list">${tags.map((tag) => `<b>#${escapeHtml(tag)}</b>`).join("")}</div>` : ""}
    </article>
  `;
}

async function renderStudy(loadedBooks) {
  const stats = document.querySelector("[data-study-stats]");
  const goalSlot = document.querySelector("[data-study-goal]");
  const activitySlot = document.querySelector("[data-study-activity]");
  const booksSlot = document.querySelector("[data-study-book-goals]");
  if (!stats || !goalSlot || !activitySlot || !booksSlot) return;

  const books = loadedBooks || (await getSavedBooks());
  const dailyGoal = getDailyPageGoal();
  const finishGoals = getFinishGoals();
  const today = getTodayStudyStats(books);
  const weekRows = getDailyStudyRows(books, 7);
  const weekTotals = weekRows.reduce(
    (total, row) => ({
      secondsRead: total.secondsRead + row.secondsRead,
      pagesRead: total.pagesRead + row.pagesRead,
      quotesSaved: total.quotesSaved + row.quotesSaved,
    }),
    { secondsRead: 0, pagesRead: 0, quotesSaved: 0 }
  );
  const remainingToday = Math.max(dailyGoal - today.pagesRead, 0);
  const goalPercent = Math.min(Math.round((today.pagesRead / Math.max(dailyGoal, 1)) * 100), 100);
  const maxPages = Math.max(...weekRows.map((row) => row.pagesRead), dailyGoal, 1);

  stats.innerHTML = `
    <article class="stat-card"><span>Reading today</span><strong>${formatReadingTime(today.secondsRead)}</strong><p>Active reader time</p></article>
    <article class="stat-card accent-gold"><span>Pages today</span><strong>${today.pagesRead}</strong><p>${remainingToday ? `${remainingToday} left for goal` : "Goal reached"}</p></article>
    <article class="stat-card accent-green"><span>Quotes today</span><strong>${today.quotesSaved}</strong><p>Captured while reading</p></article>
  `;

  goalSlot.innerHTML = `
    <div class="section-header compact">
      <div>
        <p class="eyebrow">Daily goal</p>
        <h2>${remainingToday ? `Read ${remainingToday} more pages today` : "Daily page goal complete"}</h2>
      </div>
      <form class="goal-form" data-daily-goal-form>
        <label>
          <span>Pages/day</span>
          <input type="number" name="dailyGoal" min="1" max="999" value="${dailyGoal}">
        </label>
        <button class="primary-action" type="submit">Save</button>
      </form>
    </div>
    <div class="goal-progress">
      <div class="goal-progress-topline">
        <strong>${today.pagesRead} / ${dailyGoal} pages</strong>
        <span>${goalPercent}%</span>
      </div>
      <div class="activity-meter large" aria-hidden="true"><span style="width: ${goalPercent}%"></span></div>
    </div>
  `;

  activitySlot.innerHTML = `
    <div class="section-header compact">
      <div>
        <p class="eyebrow">Last 7 days</p>
        <h2>Reading activity</h2>
      </div>
      <div class="activity-summary">
        <b>${weekTotals.pagesRead}</b>
        <span>pages</span>
        <b>${formatReadingTime(weekTotals.secondsRead)}</b>
        <span>tracked</span>
      </div>
    </div>
    <div class="activity-list">${weekRows.map((row) => createActivityBar(row, maxPages, dailyGoal)).join("")}</div>
  `;

  if (!books.length) {
    renderEmptyState(booksSlot, "Upload a PDF to start tracking reading time, pages, quotes, and goals.", "No books yet");
    fitSidebarText();
    return;
  }

  booksSlot.innerHTML = books.map((book) => createBookGoalRow(book, finishGoals)).join("");

  fitSidebarText();
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

  const query = getShelfSearchQuery();
  const visibleBooks = sortShelfBooks(
    books.filter((book) => matchesShelfSearch(book, query)),
    getActiveShelfSort()
  );
  if (!visibleBooks.length) {
    renderEmptyState(grid, "No books match your search yet.", "No matching books");
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
  await renderStudy(books);

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
  let renderedPageSize = { width: 0, height: 0 };
  let lastReadingTick = document.visibilityState === "visible" ? Date.now() : null;
  let pendingReadingSeconds = 0;
  let readingFlushPromise = Promise.resolve();

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

  function collectReadingSeconds() {
    const now = Date.now();
    if (document.visibilityState !== "visible") {
      lastReadingTick = null;
      return;
    }
    if (!lastReadingTick) {
      lastReadingTick = now;
      return;
    }
    const elapsedSeconds = Math.floor((now - lastReadingTick) / 1000);
    lastReadingTick = now;
    if (elapsedSeconds > 0) {
      pendingReadingSeconds += Math.min(elapsedSeconds, 60);
    }
  }

  async function flushReadingSeconds() {
    collectReadingSeconds();
    if (!pendingReadingSeconds) return;
    const secondsRead = pendingReadingSeconds;
    pendingReadingSeconds = 0;
    readingFlushPromise = readingFlushPromise
      .catch(() => null)
      .then(() => recordReadingActivity(book.id, { date: todayKey(), secondsRead }));
    await readingFlushPromise;
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
    const pixelRatio = Math.max(window.devicePixelRatio || 1, 1);
    const outputScale = Math.min(pixelRatio, 3);
    const cssWidth = Math.floor(viewport.width);
    const cssHeight = Math.floor(viewport.height);

    renderedPageSize = { width: cssWidth, height: cssHeight };
    targetCanvas.width = Math.floor(cssWidth * outputScale);
    targetCanvas.height = Math.floor(cssHeight * outputScale);
    targetCanvas.style.width = `${cssWidth}px`;
    targetCanvas.style.height = `${cssHeight}px`;

    await page.render({
      canvasContext: targetContext,
      transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
      viewport,
    }).promise;
    return viewport;
  }

  function clearTextLayer() {
    const width = renderedPageSize.width || canvas.clientWidth || canvas.width;
    const height = renderedPageSize.height || canvas.clientHeight || canvas.height;

    textLayer.innerHTML = "";
    textLayer.style.width = `${width}px`;
    textLayer.style.height = `${height}px`;
    pdfFrame.style.width = `${width}px`;
    pdfFrame.style.height = `${height}px`;
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
    const width = renderedPageSize.width || canvas.clientWidth || canvas.width;
    const height = renderedPageSize.height || canvas.clientHeight || canvas.height;
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

  const readingTimer = window.setInterval(() => {
    flushReadingSeconds().catch((error) => console.warn("Reading time could not be saved", error));
  }, 30000);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushReadingSeconds().catch((error) => console.warn("Reading time could not be saved", error));
      return;
    }
    lastReadingTick = Date.now();
  });

  window.addEventListener("pagehide", () => {
    window.clearInterval(readingTimer);
    flushReadingSeconds().catch((error) => console.warn("Reading time could not be saved", error));
  });

  setReaderMode(readerMode);
  await drawPage(currentPage);
}

async function init() {
  registerServiceWorker();
  bindUploadButtons();
  bindInstallPrompt();
  bindRenameControls();
  bindNotesTools();
  bindStudyTools();
  bindShelfFilters();
  const books = await getSavedBooks();
  try {
    await renderDashboard(books);
    await renderShelf(books);
    await renderNotes(books);
    await renderQuotesPage();
    await renderStudy(books);
    await renderReader();
  } catch (error) {
    console.error(error);
    throw error;
  }
  fitSidebarText();
}

init().catch((error) => {
  console.error(error);
  showStatus("QuoteBook could not start. Refresh the page or restart the server with make run.", "error");
});
