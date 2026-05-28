# Reading Tracker

A personal reading tracker that helps users record books, track reading progress, write notes, save vocabulary, and write summaries.

## Features

- Upload PDF version of the book to add books.
- Track current page and reading percentage, time and date of reading.
- Selecting quotes and write side notes for each book
- Mark the unknown vocab and provide its translation.
- Writing summary of the book

## Tech Stack

- Frontend: HTML, CSS, JavaScript
- Backend: Django
- Database: SQLite / PostgreSQL
- Version Control: Git + GitHub

## Project Structure

```text
ReadingTracker/
├── frontend/
│   ├── index.html
│   ├── shelf.html
│   ├── notes.html
│   ├── vocabulary.html
│   ├── reader.html
│   ├── styles.css
│   ├── app.js
│   └── assets/
├── backend/
│   └── README.md
├── index.html
├── README.md
└── LICENSE
```

The current frontend pages are located in `frontend/`. The root `index.html` redirects to the dashboard page for easier opening and deployment. The `backend/` folder is prepared for the future Django implementation.

## Run Locally

From the project root:

```bash
cd frontend
python3 -m http.server 8000
```

If port `8000` is already busy, use another port such as `8002`.

Then open:

- Dashboard: `http://localhost:8000/`
- Shelf: `http://localhost:8000/shelf.html`
- Notes: `http://localhost:8000/notes.html`
- Vocabulary: `http://localhost:8000/vocabulary.html`

Uploaded PDFs are stored locally in the browser with IndexedDB and opened with PDF.js. After upload, each PDF appears as a selectable book on the Shelf page and opens in `reader.html`.

## My Contribution

- Designed the book tracking system
- Built the progress tracking logic
- Implemented note-taking features
- Created the README and project documentation
- Managed GitHub issues and feature planning

## Future Improvements

- User login system
- Search and filter books
- Reading statistics dashboard
- Export notes as PDF
