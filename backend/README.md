# Backend

This Django backend saves uploaded PDFs to disk and stores book metadata in SQLite.

## Run Locally

From the project root:

```bash
python3 -m pip install -r backend/requirements.txt
cd backend
python3 manage.py migrate
python3 manage.py runserver 8010
```

Uploaded PDFs are saved in:

```text
backend/uploads/pdfs/
```

The frontend expects the backend API at `http://localhost:8010`.
