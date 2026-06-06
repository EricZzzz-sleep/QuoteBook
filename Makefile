.PHONY: install migrate run

PYTHON ?= python3
PORT ?= 8000

install:
	$(PYTHON) run.py --install-only

migrate:
	cd backend && $(PYTHON) manage.py migrate

run:
	PORT=$(PORT) $(PYTHON) run.py
