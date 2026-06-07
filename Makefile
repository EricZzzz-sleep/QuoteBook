.PHONY: install migrate run desktop-check desktop-backend desktop-mac desktop-win

PYTHON ?= python3
PORT ?= 8000

install:
	$(PYTHON) run.py --install-only

migrate:
	cd backend && $(PYTHON) manage.py migrate

run:
	PORT=$(PORT) $(PYTHON) run.py

desktop-check:
	node --check desktop/main.js
	node --check scripts/create_desktop_icons.js
	node --check scripts/run_pyinstaller.js
	node --check scripts/sign_mac_app.js
	node --check scripts/notarize_mac_app.js
	$(PYTHON) -m py_compile desktop/backend_launcher.py
	$(PYTHON) -m py_compile scripts/create_desktop_icons.py

desktop-backend:
	$(PYTHON) -m pip install -r backend/requirements-desktop.txt
	npm run build:backend

desktop-mac:
	npm run build:mac

desktop-win:
	npm run build:win
