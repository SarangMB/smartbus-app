# SmartBus — Node.js, Express, EJS and MongoDB

A responsive college transport portal prototype with student registration, admin-created driver accounts, boarding-point fare management, automatic bus allocation, QR-coded digital passes, payment ledger, pass verification and driver GPS sharing.

## Requirements
- Node.js 18+ and npm
- MongoDB Server running locally (MongoDB Compass is the GUI/client; the server must also be running)
- VS Code (recommended)

## Setup
1. Extract this folder and open `SmartBus_Node_Express_MongoDB` in VS Code.
2. Copy `.env.example` to a new file named `.env`.
3. Edit `.env`. Keep `MONGO_URI=mongodb://127.0.0.1:27017/smartbus` to use a separate `smartbus` database. Choose a private `SESSION_SECRET`, `ADMIN_USERNAME`, and `ADMIN_PASSWORD` (at least 8 characters).
4. In the VS Code terminal run:
   ```bash
   npm install
   npm start
   ```
5. Open http://localhost:3000.
6. Sign in to the administrator account using the `ADMIN_USERNAME` and `ADMIN_PASSWORD` you configured in `.env`. The app creates or synchronizes the administrator account named in `.env` and creates default boarding points if none exist. Students can register using the Sign up link. Drivers cannot self-register; the admin creates their accounts.

### Existing database note
If you previously ran an older SmartBus version, its old demo users and collections remain in MongoDB; this version does not delete user data automatically. The newer app no longer creates student/driver demo accounts in code. Review existing records before removing anything. The account named in `ADMIN_USERNAME` is created if missing, or its password is synchronized from `.env` if that username is already an admin. Legacy accounts from the older prototype are not automatically deleted.

## Features implemented
- Student self-signup; passwords stored using bcrypt hashes.
- Role-based sessions for students, drivers and admins.
- Admin-only driver account creation and bus assignment, stored in a dedicated `drivers` MongoDB collection (created on startup even before the first driver is added).
- Driver verification workflow: new driver logins remain disabled until an admin verifies them; admins can revoke verification to disable access.
- Existing driver accounts are copied into the dedicated `drivers` collection at startup without deleting existing data.
- Admin can add/edit boarding points, fare and bus assignment. Bus numbers are standardized using a dropdown and server-side validation (`BUS-01` through `BUS-10`). A version field protects against overwriting a newer fare edit.
- Student selects a boarding point and sees its fare and assigned bus.
- Simulated successful/failed payments are saved to a separate `payments` collection. Successful payment creates a 30-day pass in `buspasses` and stores the pass ID on the payment record.
- QR code image is generated per pass. The QR contains a structured payload with pass ID, transaction ID, student, stop, bus, amount, payment/pass status and expiry.
- Driver verification checks pass existence, payment/pass status, expiry and assigned bus using pass ID or transaction ID.
- Driver location is stored in MongoDB; students can request the latest location for the bus assigned to their latest active pass.
- Admin can inspect issued passes and payment records.
- MongoDB collections include `users`, `drivers`, `stops`, `buspasses`, `payments`, `buslocations`, and `sessions` (Mongoose pluralizes model names).

## Simulated / not production-ready
- Payment is a demo selection, not a real payment gateway; do not treat it as proof of real payment.
- The QR is genuinely generated, but camera-based QR scanning is not included. Drivers enter pass ID or transaction ID in the verification form. A production app should scan the QR payload and validate it server-side.
- The map uses Leaflet and OpenStreetMap tiles to show the latest location shared by a driver. It does not provide continuous tracking, route planning or ETA.
- GPS sharing depends on browser permission and keeping the driver page open. Production deployment should use HTTPS.
- For production, add CSRF protection, rate limiting, password reset, stronger validation, audit logs, secure secrets, and real payment provider webhooks. Use a strong unique session secret.

## MongoDB Compass
Connect to `mongodb://localhost:27017/`. After the app starts, refresh the databases list and open `smartbus`. The app writes its records there; it does not use another project's database unless you change `MONGO_URI`. The `drivers` collection is created at startup and receives one document for each driver created by the admin. Use the admin dashboard to verify or revoke each driver.


## Current GPS location (one-time sharing)
- Driver dashboard: click **Get and share my current location** and allow browser location permission. The browser obtains one current GPS/location fix and POSTs latitude/longitude to Express; MongoDB stores it in `buslocations`.
- Student dashboard: the assigned-bus panel requests the latest saved location and displays it on a real Leaflet map using OpenStreetMap tiles, plus coordinates and last-shared time. Click **Get latest bus location** to refresh.
- This is deliberately one-time sharing, not continuous tracking. The driver can share again to update it. Internet access is required for map tiles and the Leaflet library. Browser location permission is required; `localhost` is allowed for development, while deployed sites generally need HTTPS. Location accuracy depends on the device and browser.


## Duplicate pass/payment protection
- The renewal form includes a one-time request key and the payments collection enforces uniqueness for it, so double-clicks/retried form submissions cannot create a second pass from the same submission.
- The server blocks a second overlapping active pass for the same student and boarding point. A MongoDB unique partial index enforces this rule even if two different tabs submit at nearly the same time. Expired records are marked inactive before renewal. Students may still hold passes for different boarding points.
- At startup, recognizable legacy bus labels are standardized across stops, drivers, passes, payments, and saved locations (for example, `1` becomes `BUS-01`).
- Existing duplicate active passes for the same student and boarding point are retained for audit/history, but all except the earliest active record are marked inactive. Existing payment history is not deleted.


## Additional integrity safeguards
- If pass creation or linking the pass to its payment record fails, the prototype marks the payment attempt failed and deactivates any pass created by that failed issuance path. No real charge is made because payment is simulated.
- Creating a driver profile rolls back the pending login account if the separate driver-profile insert fails.
- Driver routes re-check that the account remains approved and the driver profile remains verified, so an already-open session is not allowed to continue after revocation.
- At startup, expired/invalid active pass records are deactivated, duplicate active passes for the same student and boarding point are retained as history but marked inactive, and a database-level unique partial index is created to prevent recurrence.
