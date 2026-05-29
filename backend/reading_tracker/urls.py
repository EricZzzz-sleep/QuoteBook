from django.contrib import admin
from django.urls import include, path, re_path
from django.views.static import serve

from books.views import add_cors_headers
from django.conf import settings


def serve_media(request, path):
    response = serve(request, path, document_root=settings.MEDIA_ROOT)
    return add_cors_headers(response)


urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/", include("books.urls")),
    re_path(r"^media/(?P<path>.*)$", serve_media),
]
