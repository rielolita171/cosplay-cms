# Phase 1: Step 1 — System Prerequisites & Dependencies

## Objective
Install and verify all required system packages on your home server (Ubuntu/Debian, CasaOS, Portainer, or Unraid terminal).

---

## Prerequisites Checklist

- [ ] **Server OS:** Ubuntu 20.04+ / Debian 11+ or equivalent
- [ ] **Network Access:** SSH access to your home server
- [ ] **Admin Privileges:** Ability to run `sudo` commands

---

## Installation Commands

### Step 1.1: Update System Packages
```bash
sudo apt update && sudo apt upgrade -y
```

### Step 1.2: Install Docker & Docker Compose
```bash
sudo apt install -y docker.io docker-compose-plugin
```

Verify installation:
```bash
docker --version
docker compose version
```

### Step 1.3: Install Node.js & npm (v18+)
```bash
sudo apt install -y nodejs npm
```

Verify installation:
```bash
node --version
npm --version
```

### Step 1.4: Install Git
```bash
sudo apt install -y git
```

Verify installation:
```bash
git --version
```

---

## Post-Installation Configuration

### Enable Docker for Your User (Avoid Sudo)
Allow your user to run Docker commands without `sudo`:

```bash
sudo usermod -aG docker $USER
newgrp docker
```

Verify access:
```bash
docker ps
```

---

## Troubleshooting

**Problem:** `docker: command not found`
- **Solution:** Restart your terminal session or run `exec bash` to activate the new group membership.

**Problem:** `npm ERR! permission denied`
- **Solution:** Ensure npm is properly installed and consider running `sudo chown -R $(whoami) ~/.npm`.

---

## Next Step
Once all prerequisites are installed and verified, proceed to **Step 2: Directory Structure Setup**.
