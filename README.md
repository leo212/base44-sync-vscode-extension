# Base44 Sync

Sync project files between your local VS Code project and a Base44 project. This extension allows you to pull remote changes, review them, and deploy your local files back to Base44.
This extension is independent and not endorsed by or associated with Base44 or Wix.

## Features

This extension provides the following commands, which can be accessed from the Command Palette (`Ctrl+Shift+P`):

*   **`Base44: Deploy Current File`**: Deploys the content of the currently active editor to your Base44 project.
*   **`Base44: Pull Remote Changes`**: Fetches the latest files from your Base44 project. It compares them with your local files and highlights any differences (added, changed, or removed lines) directly in the editor.
*   **`Base44: Accept Remote Change`**: Accepts a specific incoming change from a pulled file. You can trigger this from the hover tooltip over a change.
*   **`Base44: Reject Remote Change`**: Rejects a specific incoming change, keeping your local version. You can trigger this from the hover tooltip over a change.

## Requirements

To use this extension, you need:

1.  An active account on [Base44](https://app.base44.com/).
2.  A project created in Base44.
3.  Your Application ID and an Authentication Token from your Base44 project (use Chrome Developer Tools to retreive the Bearer token).

## Extension Settings

This extension contributes the following settings, which are required for it to function:

*   `base44-sync.appId`: Your Base44 Application ID.
*   `base44-sync.token`: Your Base44 Authentication Token. The access token can be retrieved using **Dev Tools** on Chrome while performing actions on Base44 website.

## Quick Start

1.  **Install** the extension.
2.  Run **`Base44: Pull Remote Changes`** to fetch your project files from Base44. The extension will create the necessary files and folders if they don't exist locally.
    On the first run, a configuration file will be opened so you can enter **Project ID** and **Access Token**.
4.  Review the highlighted changes in the editor. Hover over any change to see a diff and options to **Accept** or **Reject** it.
5.  Edit your files locally.
6.  When you're ready to push your changes, open the file you want to send and run **`Base44: Deploy Current File`** from the Command Palette.

## Known Issues

No known issues at this time.

## Release Notes

### 0.0.1

Initial release of the Base44 Sync extension.
- Deploy local files to Base44.
- Pull and diff remote files from Base44.
- Accept or reject individual changes.
