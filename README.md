# Base44 Sync

Sync project files between your local VS Code project and a Base44 project. This extension allows you to pull remote changes, review them, and deploy your local files back to Base44.
This extension is independent and not endorsed by or associated with Base44 or Wix.

## Features

This extension provides the following commands, which can be accessed from the Command Palette (`Ctrl+Shift+P`):

*   **`Base44: Login`**: Opens a Chrome browser window to log in to your Base44 account. After login, you'll be prompted to select an app from your account. The extension saves the token and app ID to `base44-config.json` automatically. Login is also triggered automatically when config is missing or the token has expired.
*   **`Base44: Deploy Current File`**: Deploys the content of the currently active editor to your Base44 project.
*   **`Base44: Deploy All Opened Editors`**: Deploys all currently open files to your Base44 project.
*   **`Base44: Pull Remote Changes`**: Fetches the latest files from your Base44 project. It compares them with your local files and opens a diff view for any changed files.

## Requirements

1.  An active account on [Base44](https://app.base44.com/).
2.  Google Chrome installed (used for the login flow).

## Quick Start

1.  **Install** the extension.
2.  Run **`Base44: Login`** from the Command Palette. A Chrome window will open — log in to your Base44 account, then select the app you want to work with. The extension will save your credentials to `base44-config.json` automatically.
3.  Run **`Base44: Pull Remote Changes`** to fetch your project files.
4.  Edit your files locally.
5.  Run **`Base44: Deploy Current File`** or **`Base44: Deploy All Opened Editors`** to push changes back to Base44.

> **Note:** If your token expires, any deploy or pull operation will automatically re-open the login window so you can re-authenticate without losing your work.

## Known Issues

No known issues at this time.

## Release Notes

### 0.0.5

- Added **`Base44: Login`** command — launches a real Chrome window to authenticate via Base44 (supports Google login).
- Login is triggered automatically when `base44-config.json` is missing or a request returns 401 Unauthorized.
- Removed the need to manually copy tokens or app IDs.

### 0.0.1

Initial release of the Base44 Sync extension.
- Deploy local files to Base44.
- Pull and diff remote files from Base44.
