# Phase 2: REST API & Image Engine Documentation

Comprehensive reference documentation for the Cosplay Management System (CMS) Phase 2 backend REST API.

---

## 🌐 Server & Configuration

- **Base URL**: `http://localhost:4001` (configured via `.env` `PORT`)
- **API Prefix**: `/api` (aliases are also mounted at root `/` for backward compatibility)
- **Content-Type**: `application/json` (except image uploads which use `multipart/form-data`)
- **Authentication**: Bearer Token in `Authorization` header (`Authorization: Bearer <jwt-token>`)

---

## 📋 Endpoint Summary Table

| Category | Method | Endpoint | Auth Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| **System** | `GET` | `/health` | No | Server health, uptime, and environment check |
| **System** | `GET` | `/api/version` | No | API version and available endpoint matrix |
| **Auth** | `POST` | `/api/auth/register` | No | Register new user account |
| **Auth** | `POST` | `/api/auth/login` | No | Login and receive JWT access token |
| **Auth** | `GET` | `/api/auth/profile` | Yes | Get authenticated user profile |
| **Auth** | `POST` | `/api/auth/refresh` | Yes | Refresh active JWT token |
| **Auth** | `POST` | `/api/auth/logout` | Yes | Invalidate user session client-side |
| **Costumes** | `GET` | `/api/costumes` | No | List costumes (filter by `fandom`, `status`, `brand`) |
| **Costumes** | `GET` | `/api/costumes/:id` | No | Retrieve single costume with completion % |
| **Costumes** | `POST` | `/api/costumes` | No | Create new costume record |
| **Costumes** | `PUT` | `/api/costumes/:id` | No | Update costume status, milestones, notes |
| **Costumes** | `DELETE` | `/api/costumes/:id` | No | Delete costume record |
| **Props** | `GET` | `/api/props` | No | List props (filter by `costumeId`, `category`, `condition`) |
| **Props** | `GET` | `/api/props/:id` | No | Retrieve single prop details |
| **Props** | `POST` | `/api/props` | No | Create new prop entry |
| **Props** | `PUT` | `/api/props/:id` | No | Update prop details (location, condition, notes) |
| **Props** | `DELETE` | `/api/props/:id` | No | Delete prop record |
| **Lenses** | `GET` | `/api/lenses` | No | List contact lenses (filter by `status`, `color`, `brand`) |
| **Lenses** | `GET` | `/api/lenses/:id` | No | Retrieve single lens record |
| **Lenses** | `POST` | `/api/lenses` | No | Register new lens with auto expiry tracking |
| **Lenses** | `PUT` | `/api/lenses/:id` | No | Update lens status or opened date |
| **Lenses** | `DELETE` | `/api/lenses/:id` | No | Delete lens entry |
| **Images** | `POST` | `/api/images/upload` | No | Upload single image, auto-resize to 1200px max, convert to WebP |
| **Images** | `POST` | `/api/images/upload-multiple`| No | Batch upload up to 10 images with WebP conversion |
| **Images** | `GET` | `/api/images/stats` | No | Storage statistics (file count, total MB) |

---

## 1. Authentication Endpoints

### `POST /api/auth/register`
Creates a new user record and returns an authenticated JWT token.

**Request Body:**
```json
{
  "username": "cosplayer123",
  "email": "cosplayer@example.com",
  "password": "SecurePassword123!"
}
```

**Response (201 Created):**
```json
{
  "id": "7f8b9c2a-1234-5678-90ab-cdef12345678",
  "username": "cosplayer123",
  "email": "cosplayer@example.com",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "role": "user",
  "message": "User registered successfully"
}
```

---

### `POST /api/auth/login`
Authenticates credentials and returns a 7-day JWT token.

**Request Body:**
```json
{
  "username": "cosplayer123",
  "password": "SecurePassword123!"
}
```

**Response (200 OK):**
```json
{
  "id": "7f8b9c2a-1234-5678-90ab-cdef12345678",
  "username": "cosplayer123",
  "email": "cosplayer@example.com",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "role": "user"
}
```

---

### `GET /api/auth/profile`
Protected endpoint returning current user details.

**Headers:**
```
Authorization: Bearer <jwt-token>
```

**Response (200 OK):**
```json
{
  "id": "7f8b9c2a-1234-5678-90ab-cdef12345678",
  "username": "cosplayer123",
  "email": "cosplayer@example.com",
  "createdAt": "2026-09-27T01:23:45.678Z",
  "role": "user"
}
```

---

## 2. Costume Endpoints

### `GET /api/costumes`
List costumes with optional filtering.

**Query Parameters:**
- `fandom` (string): Search fandom name (substring match)
- `status` (string): `IN_POSSESSION`, `ON_RENT`, `TO_BE_SOLD`, `WISHLIST`
- `brand` (string): Search brand/maker (substring match)

**Example Request:**
```bash
curl "http://localhost:4001/api/costumes?fandom=Genshin&status=IN_POSSESSION"
```

**Response (200 OK):**
```json
{
  "count": 1,
  "costumes": [
    {
      "id": "a9e1d2c3-4567-8901-2345-678901234567",
      "character": "Raiden Shogun",
      "fandom": "Genshin Impact",
      "brand": "Miaowu",
      "size": "M",
      "isFullset": "1",
      "status": "IN_POSSESSION",
      "buyPrice": "850000"
    }
  ],
  "filters": {
    "fandom": "Genshin",
    "status": "IN_POSSESSION",
    "brand": null
  }
}
```

---

### `GET /api/costumes/:id`
Fetch single costume with calculated milestone completion percentage.

**Response (200 OK):**
```json
{
  "id": "a9e1d2c3-4567-8901-2345-678901234567",
  "character": "Raiden Shogun",
  "fandom": "Genshin Impact",
  "brand": "Miaowu",
  "size": "M",
  "isFullset": "1",
  "doneCostest": "1",
  "doneEvent": "1",
  "donePhotoSession": "0",
  "status": "IN_POSSESSION",
  "buyPrice": "850000",
  "notes": "Includes wig and hair accessories",
  "referenceUrl": null,
  "imageUrls": "[]",
  "completionPercent": 75
}
```

---

### `POST /api/costumes`
Create a new costume item.

**Request Body:**
```json
{
  "character": "Kafka",
  "fandom": "Honkai: Star Rail",
  "brand": "Dokidoki SR",
  "size": "M",
  "notes": "Coat, shirt, shorts, gloves, sunglasses",
  "referenceUrl": "https://example.com/kafka"
}
```

**Response (201 Created):**
```json
{
  "id": "b1c2d3e4-5678-90ab-cdef-1234567890ab",
  "character": "Kafka",
  "fandom": "Honkai: Star Rail",
  "brand": "Dokidoki SR",
  "size": "M",
  "status": "IN_POSSESSION",
  "isFullset": false,
  "createdAt": "2026-09-27T01:23:45.678Z"
}
```

---

## 3. Props Endpoints

### `GET /api/props`
List all props with query filtering.

**Query Parameters:**
- `costumeId` (string): Filter by parent costume UUID
- `category` (string): `Weapon`, `Armor`, `Headpiece`, `Wig`, `Accessory`, `Shoes`
- `condition` (string): `Mint`, `Good`, `Minor Wear`, `Needs Repair`, `Damaged`

---

### `POST /api/props`
Add a prop linked to a costume.

**Request Body:**
```json
{
  "costumeId": "a9e1d2c3-4567-8901-2345-678901234567",
  "name": "Engulfing Lightning",
  "category": "Weapon",
  "location": "Prop Box 2 - Hallway Closet",
  "condition": "Mint",
  "notes": "Detachable PVC polearm"
}
```

**Response (201 Created):**
```json
{
  "id": "c1d2e3f4-7890-abcd-ef12-34567890abcd",
  "costumeId": "a9e1d2c3-4567-8901-2345-678901234567",
  "name": "Engulfing Lightning",
  "category": "Weapon",
  "location": "Prop Box 2 - Hallway Closet",
  "condition": "Mint",
  "createdAt": "2026-09-27T01:23:45.678Z"
}
```

---

## 4. Contact Lens Endpoints

### `GET /api/lenses`
List contact lenses with calculated status.

**Query Parameters:**
- `status`: `UNOPENED`, `ACTIVE`, `EXPIRING_SOON`, `EXPIRED`, `DISPOSED`
- `color`: Substring search (e.g., `Purple`, `Red`, `Amber`)
- `brand`: Brand name

---

### `POST /api/lenses`
Register contact lens vial with auto-expiry computation.

**Request Body:**
```json
{
  "character": "Raiden Shogun",
  "color": "Electric Violet",
  "brand": "Sweety Spata",
  "prescription": "-1.50",
  "purchaseDate": "2026-01-10",
  "expiryDate": "2027-01-10",
  "notes": "14.5mm diameter"
}
```

---

## 5. Image Optimization Pipeline

### `POST /api/images/upload`
Uploads image, auto-resizes to maximum 1200px width/height, converts to WebP format, deletes original source, and saves to `data/uploads/`.

**Form Data:**
- `image`: Binary file (JPEG, PNG, WebP, GIF - max 10MB)

**Response (201 Created):**
```json
{
  "success": true,
  "originalName": "raiden_photo.jpg",
  "size": 3412589,
  "processedUrl": "/uploads/d1e2f3a4-1234567890.webp",
  "format": "WebP",
  "message": "Image uploaded and optimized successfully"
}
```

---

## 6. Running Automated Tests

A 24-point test suite is provided in [`scripts/test_api.js`](file:///home/natanieldt/cosplay-cms/scripts/test_api.js).

### To execute the test suite:
1. Ensure the server is running:
   ```bash
   npm start
   ```
2. In a second terminal, execute:
   ```bash
   npm test
   # OR
   node scripts/test_api.js
   ```
