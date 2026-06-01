from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("books", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="book",
            name="daily_goal_pages",
            field=models.PositiveIntegerField(default=20),
        ),
        migrations.AddField(
            model_name="book",
            name="last_read_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="book",
            name="reading_dates",
            field=models.JSONField(default=list),
        ),
    ]
