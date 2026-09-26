# Phase 1: Step 2 — Directory Structure Setup

## Objective
Create the persistent data directories and folder hierarchy on your host server that will store SQLite databases, user uploads, and import files.

---

## Directory Structure to Create

```
~/cosplay-cms/
├── data/
│   ├── db/              # SQLite database file location
│   └── uploads/         # User-uploaded images (optimized WebP)
├── imports/             # Excel source files for import
├── prisma/              # Database schema
└── scripts/             # Import & migration scripts
```

---

## Step 2.1: Create Main Directory
Navigate to your home directory and create the root CMS folder:

```bash
cd ~
mkdir -p cosplay-cms
cd cosplay-cms
```

## Step 2.2: Create Subdirectories
```bash
mkdir -p data/db
mkdir -p data/uploads
mkdir -p imports
mkdir -p prisma
mkdir -p scripts
```

## Step 2.3: Verify Structure
```bash
tree ~/cosplay-cms
```

Expected output:
```
~/cosplay-cms/
├── data/
│   ├── db/
│   └── uploads/
├── imports/
├── prisma/
└── scripts/
```

---

## Step 2.4: Set Proper Permissions

Ensure Docker and Node processes can read/write to these directories:

```bash
chmod -R 775 ~/cosplay-cms/data
chmod -R 775 ~/cosplay-cms/imports
```

### Verify Permissions:
```bash
ls -la ~/cosplay-cms/
ls -la ~/cosplay-cms/data/
```

You should see `drwxrwxr-x` (775 permissions) for each directory.

---

## Step 2.5: Prepare Excel Import File

Copy your existing costume inventory spreadsheet into the imports directory:

```bash
cp /path/to/your/"Costume Inventory List (1).xlsx" ~/cosplay-cms/imports/
```

Verify:
```bash
ls -l ~/cosplay-cms/imports/
```

---

## Troubleshooting

**Problem:** `mkdir: cannot create directory`
- **Solution:** Check disk space with `df -h` and ensure you have write permissions in the home directory.

**Problem:** Permission denied when accessing directories
- **Solution:** Run `sudo chown -R $USER:$USER ~/cosplay-cms` to claim ownership.

---

## Next Step
Once directories are created and verified, proceed to **Step 3: Environment Configuration (.env file)**.
