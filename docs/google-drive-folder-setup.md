# Google Drive Folder Setup Guide

## Why Use a Folder?

Creating spreadsheets inside a folder in **your personal Google Drive** (instead of the service account's Drive) solves the quota issue:

- ✅ Files count against **your personal quota** (15 GB), not the service account's quota
- ✅ You have full control over the files
- ✅ Service account can still edit the spreadsheets (with proper sharing)
- ✅ Spreadsheet URLs work exactly the same

## Step-by-Step Setup

### 1. Get Your Folder ID

1. Open Google Drive: https://drive.google.com
2. Navigate to your folder (e.g., "PolySignal Copy Trading")
3. Open the folder
4. Look at the URL in your browser - it will look like:
   ```
   https://drive.google.com/drive/folders/FOLDER_ID_HERE
   ```
5. Copy the `FOLDER_ID_HERE` part (it's a long string of letters and numbers)

**Example:**
- URL: `https://drive.google.com/drive/folders/1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p`
- Folder ID: `1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p`

### 2. Share Folder with Service Account

1. In your folder, click the **"Share"** button (or right-click > Share)
2. In the "Share" dialog, click **"Add people and groups"**
3. Enter your **service account email** (you'll see this in server logs: `📧 Service Account Email: ...`)
   - Format: `your-service-account@project-id.iam.gserviceaccount.com`
4. Set permission to **"Editor"** (not "Viewer")
5. Click **"Send"** (you can uncheck "Notify people" if you want)

### 3. Configure Environment Variable

Add to your `.env` file:

```env
# Google Drive folder ID where spreadsheets will be created
# Get this from the folder URL: https://drive.google.com/drive/folders/FOLDER_ID
GOOGLE_SHEETS_FOLDER_ID=your_folder_id_here
```

### 4. Restart Server

After adding the folder ID, restart your Docker container:

```bash
docker-compose restart
```

## How It Works

- **Spreadsheets created in your folder** → Use your quota ✅
- **Service account has Editor access** → Can create/edit files ✅
- **Spreadsheet URLs still work** → Same format: `https://docs.google.com/spreadsheets/d/SPREADSHEET_ID` ✅
- **All features work** → Appending, updating, formatting all work normally ✅

## Verification

After restarting, check the logs for:

```
📁 Spreadsheets will be created in folder ID: your_folder_id
   Make sure this folder is shared with the service account (service-account@...) with Editor access
📁 Creating spreadsheet "PolySignal CopyTrade - Free Signals" in folder your_folder_id...
✅ Created spreadsheet in folder: https://docs.google.com/spreadsheets/d/...
```

## Troubleshooting

### Error: "File not found" or "Permission denied"
- Make sure the folder is shared with the service account email
- Make sure the service account has **"Editor"** permission (not "Viewer")
- Verify the folder ID is correct in `.env`

### Error: "Parent not found"
- Double-check the folder ID in the URL
- Make sure the folder exists and you have access to it
- Try removing the folder ID temporarily to test if it's the issue

### Spreadsheets still not created
- Check server logs for detailed error messages
- Verify `GOOGLE_SHEETS_ENABLED=true` in `.env`
- Check that the service account JSON file is valid

