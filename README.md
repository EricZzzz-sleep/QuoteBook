# Reading Notebook

Reading Notebook is a personal PDF reading workspace for keeping books, saved pages, quotes, side notes, and tags in one place. It is designed as a note-taking helper rather than a completion tracker.

## Features

- Upload PDF books into a personal shelf.
- Open PDFs in a browser reader with saved page position.
- Jump directly to a page by typing a page number.
- Select passages and save quote notes with optional tags.
- Review quotes by book and by page.
- Manage and delete saved quotes.
- Export one book's saved quotes as a PDF.
- Fall back to browser storage when the Django backend is unavailable.

## Tech Stack

- Frontend: HTML, CSS, JavaScript
- Backend: Django
- Database: SQLite for local development
- PDF rendering: PDF.js
- OCR fallback: Tesseract.js
- PDF export: jsPDF

## Project Structure

```text
ReadingTracker/
├── frontend/
│   ├── index.html
│   ├── shelf.html
│   ├── notes.html
│   ├── quotes.html
│   ├── reader.html
│   ├── styles.css
│   ├── app.js
│   └── assets/
├── backend/
│   ├── books/
│   ├── reading_tracker/
│   ├── uploads/
│   ├── manage.py
│   └── requirements.txt
├── index.html
├── Makefile
├── README.md
└── LICENSE
```

The Django backend serves the frontend pages, stores book metadata, exposes the API, and saves uploaded PDFs under `backend/uploads/pdfs/`. The root `index.html` redirects to the dashboard for easier direct opening and deployment.

## Run Locally

From the project root:

```bash
make install
make run
```

Use `make install` the first time to install backend dependencies. `make run` serves the app and API together at:

```text
http://localhost:8000
```

If you prefer to run Django manually:

```bash
python3 -m pip install -r backend/requirements.txt
cd backend
python3 manage.py migrate
python3 manage.py runserver 8000
```

If port `8000` is busy, use another port such as `8002`.

## Main Pages

- Dashboard: `http://localhost:8000/`
- Shelf: `http://localhost:8000/shelf.html`
- Notes: `http://localhost:8000/notes.html`
- Book quotes: opened from the Notes page
- PDF reader: opened from Shelf or a quote link

## Storage Notes

Uploaded PDFs are saved to `backend/uploads/pdfs/`, and book metadata is stored in `backend/db.sqlite3`.

If the backend is unavailable, the frontend falls back to browser IndexedDB storage. Browser storage is separated by origin, so `http://localhost:8000/` and `http://localhost:8002/` have different local libraries.

Uploaded PDFs are ignored by git except for `.gitkeep`, so local reading files do not become project changes.

## Testing

Backend tests:

```bash
cd backend
python3 manage.py test books
```

Frontend syntax check:

```bash
node --check frontend/app.js
```

## Frontend Smoke Checklist

- Upload a PDF and confirm it opens in the reader.
- Jump pages with the page number input.
- Save a quote with a side note and tags.
- Delete a quote from the reader Page Quotes panel without refreshing.
- Open Notes and confirm it shows books only.
- Open one book's Quotes page, use Manage Quotes, and export a quote PDF.
- Check Shelf and Reader layouts on a narrow mobile viewport.

## My Contribution

- Designed the reading notebook experience and core user flow.
- Built the saved-page and PDF reader interactions.
- Implemented quote capture, tagging, quote management, and PDF export.
- Built the Django API and local storage fallback behavior.
- Created project documentation and testing notes.

## Future Improvements

- Cleaner quote review and tag organization.
- Backup and restore for the local notebook.
- Optional account sync after the single-user notebook is stable.
- Lightweight browser smoke tests for the frontend flows.
