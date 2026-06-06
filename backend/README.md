# QuoteBook Backend

This Django backend serves the static frontend, saves uploaded PDFs to disk, stores book metadata in SQLite, and exposes the local API used by the reader.

## Run Locally

From the project root:

```bash
python3 run.py
```

On Windows, use `python run.py`. The launcher creates `.venv`, installs dependencies, runs migrations, and starts the app at `http://localhost:8000`.

Uploaded PDFs are saved in:

```text
backend/uploads/pdfs/
```

The frontend expects the backend API on the same origin as the served pages. With the commands above, open `http://localhost:8000`.

For a downloadable laptop-style app, host the `frontend/` folder as a static PWA. Static hosting stores each user's library in their own browser storage. Use the Django backend when you want uploaded PDFs saved to the local server filesystem instead.
