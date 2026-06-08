# QuoteBook

QuoteBook is a personal PDF reading memory for keeping books, saved pages, quote notes, reading analytics, and goals in one place. It is designed to turn reading into visible progress and reusable knowledge rather than generic PDF comments.

## Features

- Upload PDF books into a personal shelf.
- Open PDFs in a browser reader with saved page position.
- Jump directly to a page by typing a page number.
- Select passages and save quote notes with optional keywords.
- Search saved quotes across every PDF by quote text, side note, book title, page, or keyword.
- Click keyword chips to collect related evidence across books.
- Track active reading time, pages read, and quotes saved by day.
- Set a daily page goal and see how many pages are left today.
- Set per-book finish dates and calculate the pages needed per day.
- Review quotes by book and by page.
- Manage and delete saved quotes.
- Export one book's saved quotes as a PDF.
- Export one keyword's matching quotes as a Markdown evidence brief.
- Fall back to browser storage when the Django backend is unavailable.

## Download QuoteBook

Download the installer for your laptop:

- [Download for Mac Apple Silicon](https://github.com/EricZzzz-sleep/QuoteBook/releases/latest/download/QuoteBook-mac.dmg) for M1, M2, M3, M4, or newer Macs.
- [Download for Windows](https://github.com/EricZzzz-sleep/QuoteBook/releases/latest/download/QuoteBook-windows.exe)

These links download the latest installer from GitHub Releases. The current Mac download is for Apple Silicon. The release workflow also builds `QuoteBook-mac-arm64.dmg` and `QuoteBook-mac-x64.dmg`; use the x64 file from the latest release for older Intel MacBooks once that workflow has published.

On macOS, signed and notarized builds should open normally. If QuoteBook is blocked because Apple cannot verify it is free of malware, the downloaded build is an unsigned fallback. Open `System Settings`, go to `Privacy & Security`, scroll to the security message for QuoteBook, and click `Open Anyway`. You can also try opening the Applications folder, Control-clicking `QuoteBook`, choosing `Open`, then choosing `Open` again. This warning is expected for fallback builds until the Mac app is signed and notarized with an Apple Developer account.

If a download link returns `404`, wait for the `Build desktop installers` GitHub Actions workflow to finish after the latest push to `main`. That workflow creates the GitHub Release and uploads the installer files.

If the workflow fails, open GitHub Releases, create a release with the tag `latest`, and upload the local files `dist/QuoteBook-mac.dmg`, `dist/QuoteBook-mac-arm64.dmg`, and `dist/QuoteBook-mac-x64.dmg` as temporary Mac downloads while the workflow is fixed.

To remove the macOS security warning for everyone, add these GitHub Actions secrets and rerun the `Build desktop installers` workflow:

- `MAC_CERTIFICATE`: Developer ID Application certificate exported as a `.p12` and base64 encoded.
- `MAC_CERTIFICATE_PASSWORD`: Password for the exported certificate.
- `APPLE_ID`: Apple Developer account email.
- `APPLE_APP_SPECIFIC_PASSWORD`: App-specific password for that Apple ID.
- `APPLE_TEAM_ID`: Apple Developer Team ID.

After installing, open QuoteBook from your Applications folder, Dock, Start menu, or Launchpad. Your PDFs and notes are saved locally on your laptop in QuoteBook's app-data folder.

## Web Version

QuoteBook can also be hosted as an installable web app. After it is opened from a hosted URL, users can install it from the browser and launch it from their laptop like a normal app.

To publish the web version without a backend, host the static frontend files with GitHub Pages, Netlify, Vercel, or any static web host:

```text
frontend/
```

Static hosting uses the browser's local storage fallback, so each person's books, PDFs, and notes stay on their own laptop.

## Run Locally For Development

Use this if you want to run QuoteBook from the project files.

You need Python 3.10 or newer. From the project root, run one command:

```bash
python3 run.py
```

On Windows, run:

```bash
python run.py
```

Then open:

```text
http://localhost:8000
```

The first launch may take a minute because QuoteBook creates a local `.venv`, installs Django, and prepares the SQLite database.

If port `8000` is busy, choose another port:

```bash
PORT=8002 python3 run.py
```

If you already use Make, this also works:

```bash
make run
```

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
- Study: `http://localhost:8000/study.html`
- Book quotes: opened from the Notes page
- PDF reader: opened from Shelf or a quote link

## Storage Notes

In the desktop app, uploaded PDFs and book metadata are saved in QuoteBook's app-data folder.

When running Django locally, uploaded PDFs are saved to `backend/uploads/pdfs/`, and book metadata is stored in `backend/db.sqlite3`.

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
- Save a quote with a side note and keywords.
- Confirm recent keyword suggestions appear when saving another quote.
- Delete a quote from the reader Page Quotes panel without refreshing.
- Open Notes, search across all books, click a keyword chip, and export a keyword brief.
- Open one book's Quotes page, use Manage Quotes, and export a quote PDF.
- Open Study, set a daily page goal, set a book finish date, and confirm daily reading activity appears.
- Check Shelf and Reader layouts on a narrow mobile viewport.

## My Contribution

- Designed the reading notebook experience and core user flow.
- Built the saved-page and PDF reader interactions.
- Implemented quote capture, tagging, quote management, and PDF export.
- Added cross-book keyword search and Markdown evidence briefs.
- Built Study analytics for reading time, daily pages, saved quotes, and finish-date goals.
- Built the Django API and local storage fallback behavior.
- Created project documentation and testing notes.

## Future Improvements

- Smarter trend charts and weekly reading recommendations.
- Backup and restore for the local notebook.
- Optional account sync after the single-user notebook is stable.
- Lightweight browser smoke tests for the frontend flows.
