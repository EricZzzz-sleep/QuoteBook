import json
import uuid

from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt

from .models import Book


CAPTURE_FIELDS = {
    "notes": {"quote", "note", "page"},
    "vocabulary": {"word", "translation", "page"},
    "summaries": {"summary", "page"},
}


def add_cors_headers(response):
    response["Access-Control-Allow-Origin"] = "*"
    response["Access-Control-Allow-Methods"] = "GET, POST, PATCH, OPTIONS"
    response["Access-Control-Allow-Headers"] = "Content-Type"
    return response


def json_response(data, status=200):
    return add_cors_headers(JsonResponse(data, status=status))


def parse_json_body(request):
    if not request.body:
        return {}
    return json.loads(request.body.decode("utf-8"))


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
        "cover": book.cover,
        "coverImage": book.cover_image,
        "color": book.color,
        "storageMode": "backend",
    }


def options_response():
    return add_cors_headers(JsonResponse({}))


def count_captures(value):
    return len(value) if isinstance(value, list) else 0


@csrf_exempt
def library_stats(request):
    if request.method == "OPTIONS":
        return options_response()

    if request.method != "GET":
        return json_response({"error": "Method not allowed."}, status=405)

    books = Book.objects.all()
    stats = {
        "books": books.count(),
        "pagesRead": sum(book.current_page or 0 for book in books),
        "quotes": sum(count_captures(book.notes) for book in books),
        "summaries": sum(count_captures(book.summaries) for book in books),
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

        title = request.POST.get("title") or uploaded_pdf.name.rsplit(".", 1)[0]
        total_pages = int(request.POST.get("totalPages") or 1)
        book = Book.objects.create(
            title=title,
            author=request.POST.get("author", ""),
            file_name=uploaded_pdf.name,
            file_size=uploaded_pdf.size,
            file_type=uploaded_pdf.content_type or "application/pdf",
            pdf=uploaded_pdf,
            total_pages=max(total_pages, 1),
            current_page=1,
            cover=request.POST.get("cover") or "PDF",
            cover_image=request.POST.get("coverImage", ""),
            color=request.POST.get("color") or "cover-teal",
        )
        return json_response({"book": serialize_book(book, request)}, status=201)

    return json_response({"error": "Method not allowed."}, status=405)


@csrf_exempt
def book_detail(request, book_id):
    if request.method == "OPTIONS":
        return options_response()

    try:
        book = Book.objects.get(id=book_id)
    except Book.DoesNotExist:
        return json_response({"error": "Book not found."}, status=404)

    if request.method == "GET":
        return json_response({"book": serialize_book(book, request)})

    if request.method == "PATCH":
        data = parse_json_body(request)
        if "title" in data:
            book.title = str(data["title"]).strip()[:160]
        if "author" in data:
            book.author = str(data["author"]).strip()[:120]
        if "currentPage" in data:
            book.current_page = max(1, min(int(data["currentPage"]), book.total_pages))
        if "cover" in data:
            book.cover = str(data["cover"]).strip()[:12] or "PDF"
        book.save()
        return json_response({"book": serialize_book(book, request)})

    return json_response({"error": "Method not allowed."}, status=405)


@csrf_exempt
def book_captures(request, book_id):
    if request.method == "OPTIONS":
        return options_response()

    if request.method != "POST":
        return json_response({"error": "Method not allowed."}, status=405)

    try:
        book = Book.objects.get(id=book_id)
    except Book.DoesNotExist:
        return json_response({"error": "Book not found."}, status=404)

    data = parse_json_body(request)
    capture_type = data.get("type")
    if capture_type not in CAPTURE_FIELDS:
        return json_response({"error": "Invalid capture type."}, status=400)

    allowed_fields = CAPTURE_FIELDS[capture_type]
    capture = {
        key: data.get(key, "")
        for key in allowed_fields
        if key in data
    }
    capture["id"] = str(uuid.uuid4())
    capture["page"] = max(1, min(int(capture.get("page") or book.current_page), book.total_pages))
    capture["createdAt"] = timezone.now().isoformat()

    captures = getattr(book, capture_type)
    captures.insert(0, capture)
    setattr(book, capture_type, captures)
    book.save()

    return json_response({"capture": capture, "book": serialize_book(book, request)}, status=201)
