from django.urls import path

from . import views


urlpatterns = [
    path("stats/", views.library_stats, name="library_stats"),
    path("books/", views.books_collection, name="books_collection"),
    path("books/<str:book_id>/", views.book_detail, name="book_detail"),
    path("books/<str:book_id>/captures/", views.book_captures, name="book_captures"),
    path("books/<str:book_id>/captures/<str:capture_id>/", views.book_capture_detail, name="book_capture_detail"),
]
