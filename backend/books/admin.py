from django.contrib import admin

from .models import Book


@admin.register(Book)
class BookAdmin(admin.ModelAdmin):
    list_display = ("title", "file_name", "current_page", "total_pages", "updated_at")
    search_fields = ("title", "author", "file_name")
