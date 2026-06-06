# QuoteBook

QuoteBook is a personal PDF reading workspace for keeping books, saved pages, quotes, side notes, and tags in one place. It is designed as a note-taking helper rather than a completion tracker.

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

You need Python 3.10 or newer. From the project root, run one command:

```bash
python3 run.py
```

On Windows, use:

```bash
python run.py
```

The launcher creates a local `.venv`, installs Django, prepares the SQLite database, and serves the app and API together at:

```text
http://localhost:8000
```

If port `8000` is busy, choose another port:

```bash
PORT=8002 python3 run.py
```

If you already use Make, this also works:

```bash
make run
```

## Install As A Laptop App

QuoteBook is also an installable web app. After it is opened from a hosted URL, users can install it from the browser and launch it from their laptop like a normal app.

To publish it online without a backend, host the static frontend files with GitHub Pages, Netlify, Vercel, or any static web host:

```text
frontend/
```

Static hosting uses the browser's local storage fallback, so each person's books, PDFs, and notes stay on their own laptop. For shared server storage, deploy the Django backend and serve the same frontend from Django.

Once hosted, open the site in Chrome, Edge, or Safari and use the browser's Install/Add to Dock option. On supported browsers, the dashboard also shows an `Install App` button.

If you prefer to run Django manually:

```bash
.venv/bin/python -m pip install -r backend/requirements.txt
cd backend
../.venv/bin/python manage.py migrate
../.venv/bin/python manage.py runserver 8000
```

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
