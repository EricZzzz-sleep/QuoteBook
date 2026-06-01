import tempfile

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings

from .models import Book


TEST_MEDIA_ROOT = tempfile.mkdtemp()


@override_settings(MEDIA_ROOT=TEST_MEDIA_ROOT)
class BookApiTests(TestCase):
    def make_pdf(self, name="book.pdf"):
        return SimpleUploadedFile(name, b"%PDF-1.4 test", content_type="application/pdf")

    def create_book(self, **overrides):
        defaults = {
            "title": "First Book",
            "file_name": "first.pdf",
            "pdf": "pdfs/first.pdf",
            "total_pages": 100,
            "current_page": 12,
        }
        defaults.update(overrides)
        return Book.objects.create(**defaults)

    def test_library_stats_counts_books_pages_and_quotes(self):
        self.create_book(notes=[{"quote": "One"}, {"quote": "Two"}])
        self.create_book(
            title="Second Book",
            file_name="second.pdf",
            pdf="pdfs/second.pdf",
            total_pages=80,
            current_page=4,
            notes=[{"quote": "Three"}],
            summaries=[{"summary": "Done"}],
        )

        response = self.client.get("/api/stats/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["stats"],
            {
                "books": 2,
                "pagesRead": 16,
                "quotes": 3,
            },
        )

    def test_upload_lists_and_reads_book(self):
        response = self.client.post(
            "/api/books/",
            {
                "title": "Uploaded Book",
                "author": "Reader",
                "totalPages": "42",
                "cover": "UB",
                "pdf": self.make_pdf(),
            },
        )

        self.assertEqual(response.status_code, 201)
        book = response.json()["book"]
        self.assertEqual(book["title"], "Uploaded Book")
        self.assertEqual(book["author"], "Reader")
        self.assertEqual(book["totalPages"], 42)
        self.assertEqual(book["currentPage"], 1)
        self.assertEqual(book["storageMode"], "backend")

        list_response = self.client.get("/api/books/")
        self.assertEqual(list_response.status_code, 200)
        self.assertEqual(len(list_response.json()["books"]), 1)

        detail_response = self.client.get(f"/api/books/{book['id']}/")
        self.assertEqual(detail_response.status_code, 200)
        self.assertEqual(detail_response.json()["book"]["id"], book["id"])

    def test_upload_requires_pdf_file(self):
        missing_response = self.client.post("/api/books/", {"title": "No file"})
        self.assertEqual(missing_response.status_code, 400)
        self.assertEqual(missing_response.json()["error"], "Missing PDF file.")

        text_file = SimpleUploadedFile("book.txt", b"not a pdf", content_type="text/plain")
        invalid_response = self.client.post("/api/books/", {"pdf": text_file})
        self.assertEqual(invalid_response.status_code, 400)
        self.assertEqual(invalid_response.json()["error"], "Only PDF files are allowed.")

    def test_upload_rejects_invalid_total_pages(self):
        response = self.client.post(
            "/api/books/",
            {"title": "Bad pages", "totalPages": "zero", "pdf": self.make_pdf()},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "totalPages must be a positive integer.")

    def test_patch_updates_book_and_clamps_page(self):
        book = self.create_book(total_pages=10, current_page=2)

        response = self.client.patch(
            f"/api/books/{book.id}/",
            data={
                "title": "Renamed",
                "author": "New Author",
                "currentPage": 500,
                "cover": "RN",
            },
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        updated = response.json()["book"]
        self.assertEqual(updated["title"], "Renamed")
        self.assertEqual(updated["author"], "New Author")
        self.assertEqual(updated["currentPage"], 10)
        self.assertEqual(updated["cover"], "RN")
        self.assertTrue(updated["lastReadAt"])
        self.assertTrue(updated["readingDates"])

    def test_patch_rejects_invalid_json_and_blank_title(self):
        book = self.create_book()

        invalid_json = self.client.patch(
            f"/api/books/{book.id}/",
            data="{",
            content_type="application/json",
        )
        self.assertEqual(invalid_json.status_code, 400)
        self.assertEqual(invalid_json.json()["error"], "Request body must be valid JSON.")

        blank_title = self.client.patch(
            f"/api/books/{book.id}/",
            data={"title": "  "},
            content_type="application/json",
        )
        self.assertEqual(blank_title.status_code, 400)
        self.assertEqual(blank_title.json()["error"], "Title cannot be blank.")

    def test_patch_rejects_invalid_page(self):
        book = self.create_book()

        response = self.client.patch(
            f"/api/books/{book.id}/",
            data={"currentPage": 0},
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "currentPage must be a positive integer.")

    def test_capture_adds_note_and_clamps_page(self):
        book = self.create_book(total_pages=8, current_page=3)

        response = self.client.post(
            f"/api/books/{book.id}/captures/",
            data={"type": "notes", "quote": "Important line", "note": "Remember", "tags": ["theme"], "page": 99},
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        capture = response.json()["capture"]
        self.assertEqual(capture["quote"], "Important line")
        self.assertEqual(capture["note"], "Remember")
        self.assertEqual(capture["tags"], ["theme"])
        self.assertEqual(capture["page"], 8)
        book.refresh_from_db()
        self.assertEqual(book.notes[0]["id"], capture["id"])

    def test_capture_rejects_invalid_payloads(self):
        book = self.create_book()

        invalid_type = self.client.post(
            f"/api/books/{book.id}/captures/",
            data={"type": "unknown", "quote": "Line"},
            content_type="application/json",
        )
        self.assertEqual(invalid_type.status_code, 400)
        self.assertEqual(invalid_type.json()["error"], "Invalid capture type.")

        missing_quote = self.client.post(
            f"/api/books/{book.id}/captures/",
            data={"type": "notes", "quote": " "},
            content_type="application/json",
        )
        self.assertEqual(missing_quote.status_code, 400)
        self.assertEqual(missing_quote.json()["error"], "quote is required.")

    def test_delete_capture_removes_quote(self):
        book = self.create_book(notes=[{"id": "quote-1", "quote": "Line"}])

        response = self.client.delete(f"/api/books/{book.id}/captures/quote-1/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["deleted"], True)
        book.refresh_from_db()
        self.assertEqual(book.notes, [])

    def test_delete_capture_returns_not_found(self):
        book = self.create_book(notes=[{"id": "quote-1", "quote": "Line"}])

        response = self.client.delete(f"/api/books/{book.id}/captures/missing/")

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"], "Quote not found.")

    def test_not_found_and_method_errors_are_json(self):
        missing_id = "00000000-0000-0000-0000-000000000000"

        invalid = self.client.get("/api/books/not-a-uuid/")
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(invalid.json()["error"], "Book id must be a valid UUID.")

        missing = self.client.get(f"/api/books/{missing_id}/")
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.json()["error"], "Book not found.")

        method = self.client.delete("/api/books/")
        self.assertEqual(method.status_code, 405)
        self.assertEqual(method.json()["error"], "Method not allowed.")

    def test_delete_removes_book(self):
        book = self.create_book()

        response = self.client.delete(f"/api/books/{book.id}/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["deleted"], True)
        self.assertFalse(Book.objects.filter(id=book.id).exists())
