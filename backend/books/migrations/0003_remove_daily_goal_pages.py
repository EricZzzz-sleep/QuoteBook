from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("books", "0002_reading_activity"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="book",
            name="daily_goal_pages",
        ),
    ]
