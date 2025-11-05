# Google Service Account Setup Guide

This guide walks you through creating a Google Service Account and downloading the JSON key file needed for Google Sheets integration.

## Step-by-Step Instructions

### Step 1: Go to Google Cloud Console

1. Open your web browser
2. Go to: https://console.cloud.google.com
3. Sign in with your Google account

### Step 2: Create or Select a Project

1. Click on the project dropdown at the top of the page (next to "Google Cloud")
2. Either:
   - **Select an existing project** (if you have one)
   - **Create a new project**:
     - Click "New Project"
     - Enter project name: `PolySignal` (or any name you prefer)
     - Click "Create"
     - Wait for project creation (may take a few seconds)
     - Select the new project from dropdown

### Step 3: Enable Required APIs

1. In the left sidebar, click **"APIs & Services"** > **"Library"**
2. Search for **"Google Sheets API"**:
   - Click on it
   - Click **"Enable"** button
   - Wait for it to enable
3. Search for **"Google Drive API"**:
   - Click on it
   - Click **"Enable"** button
   - Wait for it to enable

### Step 4: Create Service Account

1. In the left sidebar, click **"IAM & Admin"** > **"Service Accounts"**
2. Click the **"Create Service Account"** button at the top
3. Fill in the form:
   - **Service account name**: `polysignal-sheets` (or any name)
   - **Service account ID**: Will auto-fill (keep as is)
   - **Description** (optional): `Service account for PolySignal Google Sheets integration`
4. Click **"Create and Continue"**

### Step 5: Grant Permissions

1. In the "Grant this service account access to project" section:
   - **Role**: Select **"Editor"** from the dropdown
     - This gives the service account permission to create/edit spreadsheets
   - Alternatively, you can create a custom role with just:
     - `roles/drive.file` (Create and manage files)
     - `roles/spreadsheets.editor` (Edit spreadsheets)
2. Click **"Continue"**
3. Click **"Done"** (skip optional user access section)

### Step 6: Create and Download Key

1. You should now see your service account in the list
2. Click on the service account name (the email address)
3. Go to the **"Keys"** tab
4. Click **"Add Key"** > **"Create new key"**
5. Select **"JSON"** as the key type
6. Click **"Create"**
7. The JSON file will automatically download to your computer

### Step 7: Save the Key File

1. Find the downloaded JSON file (usually in your Downloads folder)
2. The file name will look like: `polysignal-xxxxx-xxxxx.json` or similar
3. **Rename it** to: `google-service-account.json`
4. **Move it** to your PolySignal project root directory:
   ```
   /root/polysignal/google-service-account.json
   ```
5. Verify the file is in the correct location:
   ```bash
   ls -la /root/polysignal/google-service-account.json
   ```

### Step 8: Verify File Contents

The JSON file should look something like this:

```json
{
  "type": "service_account",
  "project_id": "your-project-id",
  "private_key_id": "xxxxx",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "client_email": "polysignal-sheets@your-project-id.iam.gserviceaccount.com",
  "client_id": "xxxxx",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/..."
}
```

### Step 9: Update Environment Variables

Add to your `.env` file:

```env
GOOGLE_SHEETS_ENABLED=true
GOOGLE_SERVICE_ACCOUNT_PATH=./google-service-account.json
```

### Step 10: Verify Setup

1. Start your application
2. Check console logs for:
   - `✅ Google Sheets service initialized`
   - Or any error messages if something is wrong

## Important Notes

### Security
- **NEVER** commit the `google-service-account.json` file to git
- The file is already in `.gitignore` for safety
- Keep the file secure and private
- If the file is exposed, delete it immediately and create a new key

### Service Account Email

After creating the service account, note the email address:
- Format: `polysignal-sheets@your-project-id.iam.gserviceaccount.com`
- You'll need this email if you want to manually share existing spreadsheets with the service account

### Sharing Existing Spreadsheets

If you're using existing spreadsheets (not auto-creating):

1. Open your Google Spreadsheet
2. Click **"Share"** button (top right)
3. Enter the service account email:
   - `polysignal-sheets@your-project-id.iam.gserviceaccount.com`
4. Set permission to **"Editor"**
5. Uncheck "Notify people" (service account doesn't need notifications)
6. Click **"Share"**

## Troubleshooting

### File Not Found Error
- Verify the file path in `.env` matches actual file location
- Check file permissions: `chmod 600 google-service-account.json`
- Verify file exists: `ls -la google-service-account.json`

### Permission Denied Error
- Verify service account has "Editor" role in Google Cloud
- Check that APIs are enabled (Sheets API and Drive API)
- If using existing spreadsheets, ensure they're shared with service account email

### API Not Enabled Error
- Go to APIs & Services > Library
- Verify both "Google Sheets API" and "Google Drive API" show "Enabled"

## Quick Verification Command

After setup, verify the file exists and is readable:

```bash
cd /root/polysignal
ls -la google-service-account.json
cat google-service-account.json | jq .project_id  # If jq is installed
```

## Next Steps

Once you have the service account file:
1. Place it in project root: `/root/polysignal/google-service-account.json`
2. Update `.env` with `GOOGLE_SERVICE_ACCOUNT_PATH=./google-service-account.json`
3. Restart your application
4. The service will auto-create spreadsheets if IDs are not provided

