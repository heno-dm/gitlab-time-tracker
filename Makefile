NAME = gitlab-time-tracker
UUID = $(NAME)@gecka.nc
EXTENSION_PATH = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: build install pot clean remove test-shell test-prefs help


help:
	@echo "GitLab Time Tracking Extension - Makefile"
	@echo ""
	@echo "Available targets:"
	@echo "  build       - Build the extension package"
	@echo "  install     - Install the extension"
	@echo "  pot         - Update translation templates and merge with existing translations"
	@echo "  clean       - Clean build artifacts"
	@echo "  remove      - Remove installed extension"
	@echo "  test-shell  - Test extension in nested GNOME Shell"
	@echo "  test-prefs  - Test extension preferences"
	@echo "  help        - Show this help message"


build: clean
	@echo "Building $(UUID)..."
	
	# Compile GSettings schema
	@echo "Compiling GSettings schema..."
	set -e; if [ -d "schemas" ]; then \
	    glib-compile-schemas schemas/; \
	    echo "✓ Schema compiled successfully"; \
	else \
	    echo "Warning: schemas directory not found"; \
	fi
	
	# Compile translations
	@echo "Compiling translations..."
	set -e; if [ -d "po" ]; then \
	    for po_file in po/*.po; do \
	        if [ -f "$$po_file" ]; then \
	            lang=$$(basename "$$po_file" .po); \
	            echo "  Compiling $$lang..."; \
	            mkdir -p "locale/$$lang/LC_MESSAGES"; \
	            msgfmt "$$po_file" -o "locale/$$lang/LC_MESSAGES/$(UUID).mo"; \
	        fi; \
	    done; \
	    echo "✓ Translations compiled successfully"; \
	else \
	    echo "Warning: po directory not found"; \
	fi
	
	# Create extension package
	mkdir -p build/
	gnome-extensions pack -f \
		--extra-source=avatarLoader.js \
		--extra-source=state.js \
		--extra-source=selectorWindow.js \
		--extra-source=reportWindow.js \
		--extra-source=timeEntryDialog.js \
		--extra-source=metadata.json \
		--extra-source=LICENSE \
		--extra-source=README.md \
		--extra-source=icons \
		--extra-source=extension.js \
		--extra-source=issueSelector.js \
		--extra-source=reportDialog.js \
		--extra-source=prefs.js \
		--extra-source=stylesheet.css \
		--extra-source=locale \
		--podir=po \
		--schema=schemas/org.gnome.shell.extensions.$(NAME).gschema.xml \
		-o build/
	@echo "✓ Extension package created: build/$(UUID).shell-extension.zip"


install: build remove
	@echo "Installing $(UUID)..."
	gnome-extensions install -f build/$(UUID).shell-extension.zip
	@echo "✓ Extension installed successfully"
	@echo ""
	@echo "To enable the extension, run:"
	@echo "  gnome-extensions enable $(UUID)"
	@echo ""
	@echo "To restart GNOME Shell:"
	@echo "  - X11: Press Alt+F2, type 'r', and press Enter"
	@echo "  - Wayland: Log out and log back in"


pot:
	@echo "Updating translation templates..."
	@# Extract strings from JavaScript files
	xgettext --output=po/$(UUID).pot \
		--from-code=utf-8 \
		--package-name=$(UUID) \
		--package-version=$(shell git describe --tags --always 2>/dev/null || echo "1.0.0") \
		--msgid-bugs-address="https://github.com/Gecka-Apps/gitlab-time-tracker/issues" \
		--keyword=_ \
		--add-comments=TRANSLATORS \
		extension.js issueSelector.js selectorWindow.js reportWindow.js reportDialog.js prefs.js timeEntryDialog.js
	@echo "✓ Template updated: po/$(UUID).pot"

	@# Update LINGUAS file
	@echo "Updating LINGUAS..."
	rm -f po/LINGUAS
	for l in $$(ls po/*.po 2>/dev/null); do \
		basename $$l .po >> po/LINGUAS; \
	done
	@echo "✓ LINGUAS updated"

	@# Merge with existing translations (simplified)
	@echo "Merging translations..."
	cd po && \
	for lang in $$(cat LINGUAS 2>/dev/null); do \
		echo "  Merging $$lang..."; \
		if [ -f $$lang.po ]; then \
			msgmerge --update $$lang.po $(UUID).pot; \
		else \
			msginit --no-translator --locale=$$lang --input=$(UUID).pot -o $$lang.po; \
		fi \
	done
	@echo "✓ Translations merged successfully"


test-shell: install
	@echo "Starting nested GNOME Shell for testing..."
	@echo "Press Ctrl+C to exit"
	env GNOME_SHELL_SLOWDOWN_FACTOR=2 \
		MUTTER_DEBUG_DUMMY_MODE_SPECS=1500x1000 \
		MUTTER_DEBUG_DUMMY_MONITOR_SCALES=1 \
		dbus-run-session -- gnome-shell --nested --wayland


test-prefs: install
	@echo "Opening extension preferences..."
	gnome-extensions prefs $(UUID)


remove:
	@echo "Removing $(UUID)..."
	@if [ -d "$(EXTENSION_PATH)" ]; then \
		rm -rf $(EXTENSION_PATH); \
		echo "✓ Extension removed"; \
	else \
		echo "Extension not installed"; \
	fi


clean:
	@echo "Cleaning build artifacts..."
	rm -rf build/
	rm -f po/*.mo
	rm -f schemas/gschemas.compiled
	rm -rf locale/
	@echo "✓ Clean complete"
