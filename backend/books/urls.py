from django.urls import path

from . import views


urlpatterns = [
    path("books/", views.books_collection, name="books_collection"),
    path("books/<uuid:book_id>/", views.book_detail, name="book_detail"),
    path("books/<uuid:book_id>/captures/", views.book_captures, name="book_captures"),
]
