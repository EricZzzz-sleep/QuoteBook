from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("books", "0003_remove_daily_goal_pages"),
    ]

    operations = [
        migrations.AddField(
            model_name="book",
            name="reading_activity",
            field=models.JSONField(default=list),
        ),
    ]
