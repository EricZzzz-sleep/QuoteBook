from django.contrib import admin
from django.urls import include, path, re_path
from django.views.static import serve

from books.views import add_cors_headers
from django.conf import settings


def serve_media(request, path):
    response = serve(request, path, document_root=settings.MEDIA_ROOT)
    return add_cors_headers(response)


def serve_frontend(request, path="index.html"):
    response = serve(request, path or "index.html", document_root=settings.FRONTEND_ROOT)
    response["Cache-Control"] = "no-store"
    return add_cors_headers(response)


def serve_legacy_frontend(request, path):
    return serve_frontend(request, path)


urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/", include("books.urls")),
    re_path(r"^media/(?P<path>.*)$", serve_media),
    re_path(r"^frontend/(?P<path>(?:app\.js|styles\.css|service-worker\.js|manifest\.webmanifest|index\.html|shelf\.html|notes\.html|quotes\.html|study\.html|reader\.html|assets/.*))$", serve_legacy_frontend),
    path("", serve_frontend),
    re_path(r"^(?P<path>(?:app\.js|styles\.css|service-worker\.js|manifest\.webmanifest|index\.html|shelf\.html|notes\.html|quotes\.html|study\.html|reader\.html|assets/.*))$", serve_frontend),
]
