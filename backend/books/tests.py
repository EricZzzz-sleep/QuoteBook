from django.test import TestCase

from .models import Book


class LibraryStatsTests(TestCase):
    def test_library_stats_counts_books_pages_and_quotes(self):
        Book.objects.create(
            title="First Book",
            file_name="first.pdf",
            pdf="pdfs/first.pdf",
            total_pages=100,
            current_page=12,
            notes=[{"quote": "One"}, {"quote": "Two"}],
        )
        Book.objects.create(
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
                "summaries": 1,
            },
        )
