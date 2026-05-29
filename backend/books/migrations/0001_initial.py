import uuid

from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="Book",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("title", models.CharField(max_length=160)),
                ("author", models.CharField(blank=True, max_length=120)),
                ("file_name", models.CharField(max_length=255)),
                ("file_size", models.PositiveBigIntegerField(default=0)),
                ("file_type", models.CharField(default="application/pdf", max_length=120)),
                ("pdf", models.FileField(upload_to="pdfs/")),
                ("total_pages", models.PositiveIntegerField(default=1)),
                ("current_page", models.PositiveIntegerField(default=1)),
                ("cover", models.CharField(default="PDF", max_length=12)),
                ("cover_image", models.TextField(blank=True)),
                ("color", models.CharField(default="cover-teal", max_length=40)),
                ("notes", models.JSONField(default=list)),
                ("vocabulary", models.JSONField(default=list)),
                ("summaries", models.JSONField(default=list)),
                ("uploaded_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "ordering": ["-updated_at"],
            },
        ),
    ]
