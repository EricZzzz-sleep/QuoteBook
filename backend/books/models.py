import uuid

from django.db import models


class Book(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    title = models.CharField(max_length=160)
    author = models.CharField(max_length=120, blank=True)
    file_name = models.CharField(max_length=255)
    file_size = models.PositiveBigIntegerField(default=0)
    file_type = models.CharField(max_length=120, default="application/pdf")
    pdf = models.FileField(upload_to="pdfs/")
    total_pages = models.PositiveIntegerField(default=1)
    current_page = models.PositiveIntegerField(default=1)
    cover = models.CharField(max_length=12, default="PDF")
    cover_image = models.TextField(blank=True)
    color = models.CharField(max_length=40, default="cover-teal")
    notes = models.JSONField(default=list)
    vocabulary = models.JSONField(default=list)
    summaries = models.JSONField(default=list)
    uploaded_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]

    def __str__(self):
        return self.title
