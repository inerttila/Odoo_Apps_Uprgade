# <img src="https://raw.githubusercontent.com/inerttila/Inerttila/refs/heads/main/logo/inert-logo.jpg" width="32" height="32" align="left" /> Odoo One-Click Upgrade

MV3 Chrome extension for Odoo 17 backend pages.

Adds a floating Upgrade button that upgrades the module for the screen you are on — same path as Apps:

ir.module.module → button_immediate_upgrade

What it does
Detects the module from menu / action / view / inherit XML-IDs
Shows a best guess, plus a picker for other candidates (custom inherits)
Search installed modules by technical or display name
Confirm before upgrade (page may reload)
Drag the button anywhere; position is remembered
Click the toolbar icon to turn the extension ON / OFF

Uses your existing Odoo session. No extra login.

Install
Chrome → chrome://extensions
Enable Developer mode → Load unpacked
Select this folder
Open a logged-in Odoo 17 backend page

After reloading the extension, refresh the Odoo tab too.

Note

Built for the Odoo 17 backend (not the public website). You need the same rights as Apps → Upgrade.
