.PHONY: install migrate run

PYTHON ?= python3
PORT ?= 8000

install:
	$(PYTHON) -m pip install -r backend/requirements.txt

migrate:
	cd backend && $(PYTHON) manage.py migrate

run:
	@echo "Starting Reading Tracker at http://localhost:$(PORT)"
	@echo "Press Ctrl+C to stop the server."
	@cd backend && $(PYTHON) manage.py migrate && $(PYTHON) manage.py runserver 127.0.0.1:$(PORT)
