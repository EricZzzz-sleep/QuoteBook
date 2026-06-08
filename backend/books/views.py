import json
import uuid
from datetime import date

from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt

from .models import Book


CAPTURE_FIELDS = {
    "notes": {"quote", "note", "page", "tags"},
    "vocabulary": {"word", "translation", "page"},
    "summaries": {"summary", "page"},
}
CAPTURE_REQUIRED_FIELDS = {
    "notes": "quote",
    "vocabulary": "word",
    "summaries": "summary",
}
QUOTE_REVIEW_STATUSES = {"new", "learning", "mastered"}


def add_cors_headers(response):
    response["Access-Control-Allow-Origin"] = "*"
    response["Access-Control-Allow-Methods"] = "GET, POST, PATCH, DELETE, OPTIONS"
    response["Access-Control-Allow-Headers"] = "Content-Type"
    return response


def json_response(data, status=200):
    return add_cors_headers(JsonResponse(data, status=status))


def parse_json_body(request):
    if not request.body:
        return {}, None
    try:
        return json.loads(request.body.decode("utf-8")), None
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None, "Request body must be valid JSON."


def parse_positive_int(value, field_name, default=None):
    if value in (None, ""):
        return default, None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None, f"{field_name} must be a positive integer."
    if parsed < 1:
        return None, f"{field_name} must be a positive integer."
    return parsed, None


def parse_nonnegative_int(value, field_name, default=0):
    if value in (None, ""):
        return default, None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None, f"{field_name} must be a non-negative integer."
    if parsed < 0:
        return None, f"{field_name} must be a non-negative integer."
    return parsed, None


def parse_book_id(book_id):
    try:
        return uuid.UUID(str(book_id)), None
    except (TypeError, ValueError):
        return None, "Book id must be a valid UUID."


def get_book_or_error(book_id):
    parsed_id, error = parse_book_id(book_id)
    if error:
        return None, json_response({"error": error}, status=400)
    try:
        return Book.objects.get(id=parsed_id), None
    except Book.DoesNotExist:
        return None, json_response({"error": "Book not found."}, status=404)


def clean_text(value, max_length=None):
    cleaned = str(value or "").strip()
    if max_length:
        return cleaned[:max_length]
    return cleaned


def local_date_string(value):
    if not value:
        return ""
    return timezone.localtime(value).date().isoformat()


def add_reading_date(book, value=None):
    date_value = local_date_string(value or timezone.now())
    dates = book.reading_dates if isinstance(book.reading_dates, list) else []
    if date_value and date_value not in dates:
        dates.append(date_value)
    book.reading_dates = sorted(dates)


def merge_reading_activity(book, data):
    if not isinstance(data, dict):
        return "Activity must be a JSON object."

    date_value = clean_text(data.get("date") or local_date_string(timezone.now()), 10)
    try:
        date.fromisoformat(date_value)
    except (TypeError, ValueError):
        return "date must use YYYY-MM-DD format."

    seconds_read, error = parse_nonnegative_int(data.get("secondsRead"), "secondsRead")
    if error:
        return error
    pages_read, error = parse_nonnegative_int(data.get("pagesRead"), "pagesRead")
    if error:
        return error
    quotes_saved, error = parse_nonnegative_int(data.get("quotesSaved"), "quotesSaved")
    if error:
        return error

    if seconds_read == 0 and pages_read == 0 and quotes_saved == 0:
        return None

    activity = book.reading_activity if isinstance(book.reading_activity, list) else []
    existing = None
    next_activity = []
    for entry in activity:
        if not isinstance(entry, dict):
            continue
        if entry.get("date") == date_value:
            existing = {
                "date": date_value,
                "secondsRead": int(entry.get("secondsRead") or 0),
                "pagesRead": int(entry.get("pagesRead") or 0),
                "quotesSaved": int(entry.get("quotesSaved") or 0),
            }
        else:
            next_activity.append(entry)

    existing = existing or {"date": date_value, "secondsRead": 0, "pagesRead": 0, "quotesSaved": 0}
    existing["secondsRead"] += seconds_read
    existing["pagesRead"] += pages_read
    existing["quotesSaved"] += quotes_saved
    next_activity.append(existing)
    book.reading_activity = sorted(next_activity, key=lambda entry: entry.get("date", ""))
    return None


def serialize_book(book, request):
    return {
        "id": str(book.id),
        "title": book.title,
        "author": book.author,
        "fileName": book.file_name,
        "fileSize": book.file_size,
        "fileType": book.file_type,
        "pdfUrl": request.build_absolute_uri(book.pdf.url) if book.pdf else "",
        "totalPages": book.total_pages,
        "currentPage": book.current_page,
        "uploadedAt": book.uploaded_at.isoformat(),
        "updatedAt": book.updated_at.isoformat(),
        "notes": book.notes,
        "vocabulary": book.vocabulary,
        "summaries": book.summaries,
        "lastReadAt": book.last_read_at.isoformat() if book.last_read_at else "",
        "readingDates": book.reading_dates if isinstance(book.reading_dates, list) else [],
        "readingActivity": book.reading_activity if isinstance(book.reading_activity, list) else [],
        "cover": book.cover,
        "coverImage": book.cover_image,
        "color": book.color,
        "storageMode": "backend",
    }


def options_response():
    return add_cors_headers(JsonResponse({}))


def count_captures(value):
    return len(value) if isinstance(value, list) else 0


def normalize_note_capture(capture):
    capture.setdefault("status", "new")
    capture.setdefault("reviewCount", 0)
    capture.setdefault("lastReviewedAt", "")
    capture.setdefault("masteredAt", "")
    return capture


def parse_review_count(value):
    try:
        count = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return max(count, 0)


@csrf_exempt
def library_stats(request):
    if request.method == "OPTIONS":
        return options_response()

    if request.method != "GET":
        return json_response({"error": "Method not allowed."}, status=405)

    books = list(Book.objects.all())
    stats = {
        "books": len(books),
        "pagesRead": sum(book.current_page or 0 for book in books),
        "quotes": sum(count_captures(book.notes) for book in books),
    }
    return json_response({"stats": stats})


@csrf_exempt
def books_collection(request):
    if request.method == "OPTIONS":
        return options_response()

    if request.method == "GET":
        books = [serialize_book(book, request) for book in Book.objects.all()]
        return json_response({"books": books})

    if request.method == "POST":
        uploaded_pdf = request.FILES.get("pdf")
        if not uploaded_pdf:
            return json_response({"error": "Missing PDF file."}, status=400)

        if uploaded_pdf.content_type and uploaded_pdf.content_type != "application/pdf":
            return json_response({"error": "Only PDF files are allowed."}, status=400)
        if not uploaded_pdf.name.lower().endswith(".pdf"):
            return json_response({"error": "Only PDF files are allowed."}, status=400)

        total_pages, error = parse_positive_int(request.POST.get("totalPages"), "totalPages", default=1)
        if error:
            return json_response({"error": error}, status=400)

        title = clean_text(request.POST.get("title") or uploaded_pdf.name.rsplit(".", 1)[0], 160)
        if not title:
            return json_response({"error": "Title is required."}, status=400)
        book = Book.objects.create(
            title=title,
            author=clean_text(request.POST.get("author", ""), 120),
            file_name=uploaded_pdf.name,
            file_size=uploaded_pdf.size,
            file_type=uploaded_pdf.content_type or "application/pdf",
            pdf=uploaded_pdf,
            total_pages=total_pages,
            current_page=1,
            cover=clean_text(request.POST.get("cover") or "PDF", 12) or "PDF",
            cover_image=str(request.POST.get("coverImage", "")),
            color=clean_text(request.POST.get("color") or "cover-teal", 40) or "cover-teal",
        )
        return json_response({"book": serialize_book(book, request)}, status=201)

    return json_response({"error": "Method not allowed."}, status=405)


@csrf_exempt
def book_detail(request, book_id):
    if request.method == "OPTIONS":
        return options_response()

    book, error_response = get_book_or_error(book_id)
    if error_response:
        return error_response

    if request.method == "GET":
        return json_response({"book": serialize_book(book, request)})

    if request.method == "PATCH":
        data, error = parse_json_body(request)
        if error:
            return json_response({"error": error}, status=400)
        if not isinstance(data, dict):
            return json_response({"error": "Request body must be a JSON object."}, status=400)
        if "title" in data:
            title = clean_text(data["title"], 160)
            if not title:
                return json_response({"error": "Title cannot be blank."}, status=400)
            book.title = title
        if "author" in data:
            book.author = clean_text(data["author"], 120)
        if "currentPage" in data:
            previous_page = book.current_page or 1
            current_page, error = parse_positive_int(data["currentPage"], "currentPage")
            if error:
                return json_response({"error": error}, status=400)
            book.current_page = min(current_page, book.total_pages)
            book.last_read_at = timezone.now()
            add_reading_date(book, book.last_read_at)
            if book.current_page > previous_page:
                activity_error = merge_reading_activity(book, {
                    "date": local_date_string(book.last_read_at),
                    "pagesRead": book.current_page - previous_page,
                })
                if activity_error:
                    return json_response({"error": activity_error}, status=400)
        if "cover" in data:
            book.cover = clean_text(data["cover"], 12) or "PDF"
        book.save()
        return json_response({"book": serialize_book(book, request)})

    if request.method == "DELETE":
        book.delete()
        return json_response({"deleted": True})

    return json_response({"error": "Method not allowed."}, status=405)


@csrf_exempt
def book_captures(request, book_id):
    if request.method == "OPTIONS":
        return options_response()

    if request.method != "POST":
        return json_response({"error": "Method not allowed."}, status=405)

    book, error_response = get_book_or_error(book_id)
    if error_response:
        return error_response

    data, error = parse_json_body(request)
    if error:
        return json_response({"error": error}, status=400)
    if not isinstance(data, dict):
        return json_response({"error": "Request body must be a JSON object."}, status=400)
    capture_type = data.get("type")
    if capture_type not in CAPTURE_FIELDS:
        return json_response({"error": "Invalid capture type."}, status=400)

    allowed_fields = CAPTURE_FIELDS[capture_type]
    capture = {}
    for key in allowed_fields:
        if key not in data:
            continue
        if key == "tags":
            tags = data.get("tags")
            if isinstance(tags, str):
                tags = tags.split(",")
            if not isinstance(tags, list):
                tags = []
            capture["tags"] = [clean_text(tag, 32) for tag in tags if clean_text(tag, 32)][:8]
        else:
            capture[key] = clean_text(data.get(key, ""))
    required_field = CAPTURE_REQUIRED_FIELDS[capture_type]
    if not capture.get(required_field):
        return json_response({"error": f"{required_field} is required."}, status=400)

    page, error = parse_positive_int(capture.get("page") or book.current_page, "page")
    if error:
        return json_response({"error": error}, status=400)
    capture["id"] = str(uuid.uuid4())
    capture["page"] = min(page, book.total_pages)
    capture["createdAt"] = timezone.now().isoformat()
    if capture_type == "notes":
        normalize_note_capture(capture)

    captures = getattr(book, capture_type)
    captures.insert(0, capture)
    setattr(book, capture_type, captures)
    if capture_type == "notes":
        activity_error = merge_reading_activity(book, {
            "date": local_date_string(timezone.now()),
            "quotesSaved": 1,
        })
        if activity_error:
            return json_response({"error": activity_error}, status=400)
    book.save()

    return json_response({"capture": capture, "book": serialize_book(book, request)}, status=201)


@csrf_exempt
def book_activity(request, book_id):
    if request.method == "OPTIONS":
        return options_response()

    if request.method != "POST":
        return json_response({"error": "Method not allowed."}, status=405)

    book, error_response = get_book_or_error(book_id)
    if error_response:
        return error_response

    data, error = parse_json_body(request)
    if error:
        return json_response({"error": error}, status=400)
    if not isinstance(data, dict):
        return json_response({"error": "Request body must be a JSON object."}, status=400)

    activity_error = merge_reading_activity(book, data)
    if activity_error:
        return json_response({"error": activity_error}, status=400)
    book.last_read_at = timezone.now()
    add_reading_date(book, book.last_read_at)
    book.save()
    return json_response({"book": serialize_book(book, request)})


@csrf_exempt
def book_capture_detail(request, book_id, capture_id):
    if request.method == "OPTIONS":
        return options_response()

    if request.method not in {"PATCH", "DELETE"}:
        return json_response({"error": "Method not allowed."}, status=405)

    book, error_response = get_book_or_error(book_id)
    if error_response:
        return error_response

    notes = book.notes if isinstance(book.notes, list) else []
    if request.method == "PATCH":
        data, error = parse_json_body(request)
        if error:
            return json_response({"error": error}, status=400)
        if not isinstance(data, dict):
            return json_response({"error": "Request body must be a JSON object."}, status=400)

        status = clean_text(data.get("status", ""), 24)
        if status not in QUOTE_REVIEW_STATUSES:
            return json_response({"error": "status must be new, learning, or mastered."}, status=400)

        updated_note = None
        now = timezone.now().isoformat()
        next_notes = []
        for note in notes:
            if str(note.get("id")) == str(capture_id):
                updated_note = normalize_note_capture({**note})
                updated_note["status"] = status
                updated_note["reviewCount"] = parse_review_count(updated_note.get("reviewCount")) + 1
                updated_note["lastReviewedAt"] = now
                updated_note["masteredAt"] = now if status == "mastered" else ""
                next_notes.append(updated_note)
            else:
                next_notes.append(note)

        if updated_note is None:
            return json_response({"error": "Quote not found."}, status=404)

        book.notes = next_notes
        book.save()
        return json_response({"capture": updated_note, "book": serialize_book(book, request)})

    next_notes = [note for note in notes if str(note.get("id")) != str(capture_id)]
    if len(next_notes) == len(notes):
        return json_response({"error": "Quote not found."}, status=404)

    book.notes = next_notes
    book.save()
    return json_response({"deleted": True, "book": serialize_book(book, request)})
