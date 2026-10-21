require("dotenv").config();
const express = require("express");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const QRCode = require("qrcode");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MONGO_URI = process.env.MONGO_URI;
// Central bus-number standard: BUS-01 through BUS-10. Use the same options for stops and drivers.
const BUS_NUMBERS = Array.from({ length: 10 }, (_, i) => `BUS-${String(i + 1).padStart(2, "0")}`);
const isStandardBus = (value) => BUS_NUMBERS.includes(String(value || "").trim().toUpperCase());
const normalizeBus = (value) => { const match = String(value || "").trim().toUpperCase().match(/^BUS[-\s]?0?([1-9]|10)$/); return match ? `BUS-${String(Number(match[1])).padStart(2, "0")}` : String(value || "").trim().toUpperCase(); };
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
if (!MONGO_URI) { console.error("Missing MONGO_URI. Configure your .env file."); process.exit(1); }
app.use(session({
  name: "smartbus.sid", secret: process.env.SESSION_SECRET || "change-this-secret-before-deployment",
  resave: false, saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: MONGO_URI, collectionName: "sessions" }),
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 1000 * 60 * 60 * 8 }
}));

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  email: { type: String, lowercase: true, trim: true, default: "" },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ["student", "driver", "admin"], required: true },
  bus: { type: String, default: null },
  approved: { type: Boolean, default: true }
}, { timestamps: true });
const stopSchema = new mongoose.Schema({
  name: { type: String, unique: true, required: true, trim: true },
  fare: { type: Number, min: 0, required: true },
  bus: { type: String, required: true, default: "BUS-01", trim: true },
  version: { type: Number, default: 1 }, active: { type: Boolean, default: true }
}, { timestamps: true });
const passSchema = new mongoose.Schema({
  username: { type: String, required: true, index: true }, studentName: { type: String, required: true },
  studentEmail: { type: String, default: "" }, stopId: { type: mongoose.Schema.Types.ObjectId, ref: "Stop", required: true },
  stopName: { type: String, required: true }, bus: { type: String, required: true, index: true },
  transactionId: { type: String, unique: true, required: true }, amount: { type: Number, required: true },
  paymentStatus: { type: String, enum: ["paid", "failed"], default: "paid" },
  createdAt: { type: Date, default: Date.now }, expiresAt: { type: Date, required: true },
  status: { type: String, enum: ["active", "inactive"], default: "active" }
}, { timestamps: true });
const paymentSchema = new mongoose.Schema({
  transactionId: { type: String, unique: true, required: true }, requestKey: { type: String, unique: true, sparse: true }, username: { type: String, required: true, index: true },
  studentName: { type: String, required: true }, stopName: { type: String, required: true }, bus: { type: String, required: true },
  amount: { type: Number, required: true }, status: { type: String, enum: ["processing", "paid", "failed"], required: true },
  method: { type: String, default: "Demo payment" }, paidAt: { type: Date, default: Date.now }, passId: { type: mongoose.Schema.Types.ObjectId, ref: "BusPass", default: null }
}, { timestamps: true });
const locationSchema = new mongoose.Schema({ username: { type: String, unique: true, required: true }, bus: { type: String, required: true, index: true }, lat: Number, lng: Number, updatedAt: { type: Date, default: Date.now } });
// A dedicated collection lets admins review and verify drivers independently of login accounts.
const driverSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  email: { type: String, default: "" },
  bus: { type: String, required: true, trim: true },
  verificationStatus: { type: String, enum: ["pending", "verified", "rejected"], default: "pending" },
  verifiedAt: { type: Date, default: null },
  verifiedBy: { type: String, default: "" }
}, { timestamps: true });
const User = mongoose.model("User", userSchema);
const Stop = mongoose.model("Stop", stopSchema);
const BusPass = mongoose.model("BusPass", passSchema);
const Payment = mongoose.model("Payment", paymentSchema);
const BusLocation = mongoose.model("BusLocation", locationSchema);
const Driver = mongoose.model("Driver", driverSchema);

function flash(req, type, message) { req.session.notice = { type, message }; }
function pageData(req) { const notice = req.session.notice || null; delete req.session.notice; return { user: req.session.user || null, notice }; }
function requireLogin(req, res, next) { if (!req.session.user) return res.redirect("/"); next(); }
function requireRole(role) {
  return async (req, res, next) => {
    try {
      if (!req.session.user) return res.redirect("/");
      if (req.session.user.role !== role) {
        flash(req, "error", "You do not have permission to access that page.");
        return res.redirect("/dashboard");
      }
      // Re-check driver approval on every protected driver request. This prevents a revoked
      // driver from continuing to use an already-open session.
      if (role === "driver") {
        const [account, driverRecord] = await Promise.all([
          User.findById(req.session.user.id).select("role approved").lean(),
          Driver.findOne({ username: req.session.user.username }).select("verificationStatus").lean()
        ]);
        if (!account || account.role !== "driver" || !account.approved || driverRecord?.verificationStatus !== "verified") {
          return req.session.destroy(() => res.redirect("/"));
        }
      }
      next();
    } catch (err) { next(err); }
  };
}
function setSessionUser(req, user) { req.session.user = { id: user._id.toString(), username: user.username, role: user.role, name: user.name, bus: user.bus || null }; }

async function seedDatabase() {
  // Only the administrator is bootstrapped, using credentials chosen in .env. No student or driver demo accounts are created.
  const adminUsername = String(process.env.ADMIN_USERNAME || "").trim().toLowerCase();
  const adminPassword = String(process.env.ADMIN_PASSWORD || "");
  if (adminUsername && adminPassword.length >= 8) {
    const configuredAdmin = await User.findOne({ username: adminUsername });
    if (!configuredAdmin) {
      await User.create({ username: adminUsername, name: process.env.ADMIN_NAME || "SmartBus Administrator", email: process.env.ADMIN_EMAIL || "", passwordHash: await bcrypt.hash(adminPassword, 12), role: "admin", approved: true });
      console.log(`Administrator account created from .env: ${adminUsername}`);
    } else if (configuredAdmin.role === "admin") {
      // Keeps the administrator credential chosen in the local .env usable after an earlier prototype run.
      configuredAdmin.passwordHash = await bcrypt.hash(adminPassword, 12);
      configuredAdmin.approved = true;
      await configuredAdmin.save();
      console.log(`Administrator credentials synchronized from .env: ${adminUsername}`);
    } else {
      console.warn(`ADMIN_USERNAME '${adminUsername}' is already used by a non-admin account; choose another username in .env.`);
    }
  }
  if (!(await Stop.countDocuments())) {
    await Stop.insertMany([
      { name: "Main Gate", fare: 500, bus: "BUS-01" }, { name: "East Junction", fare: 700, bus: "BUS-01" },
      { name: "Town Centre", fare: 900, bus: "BUS-02" }, { name: "Railway Station", fare: 1100, bus: "BUS-02" },
      { name: "Beach Road", fare: 1300, bus: "BUS-03" }
    ]);
  }
  // Normalize legacy stop and driver assignments to the standard BUS-01 ... BUS-10 format where possible.
  for (const stop of await Stop.find().select("_id bus").lean()) { const standardized = normalizeBus(stop.bus); if (isStandardBus(standardized) && standardized !== stop.bus) await Stop.updateOne({ _id: stop._id }, { $set: { bus: standardized } }); }
  for (const driverUser of await User.find({ role: "driver" }).select("_id bus").lean()) { const standardized = normalizeBus(driverUser.bus); if (isStandardBus(standardized) && standardized !== driverUser.bus) await User.updateOne({ _id: driverUser._id }, { $set: { bus: standardized } }); }
  // Normalize bus labels in all records, including legacy passes and payments (e.g. "1" -> "BUS-01").
  for (const driver of await Driver.find().select("_id bus").lean()) { const standardized = normalizeBus(driver.bus); if (isStandardBus(standardized) && standardized !== driver.bus) await Driver.updateOne({ _id: driver._id }, { $set: { bus: standardized } }); }
  for (const pass of await BusPass.find().select("_id bus").lean()) { const standardized = normalizeBus(pass.bus); if (isStandardBus(standardized) && standardized !== pass.bus) await BusPass.updateOne({ _id: pass._id }, { $set: { bus: standardized } }); }
  for (const payment of await Payment.find().select("_id bus").lean()) { const standardized = normalizeBus(payment.bus); if (isStandardBus(standardized) && standardized !== payment.bus) await Payment.updateOne({ _id: payment._id }, { $set: { bus: standardized } }); }
  for (const location of await BusLocation.find().select("_id bus").lean()) { const standardized = normalizeBus(location.bus); if (isStandardBus(standardized) && standardized !== location.bus) await BusLocation.updateOne({ _id: location._id }, { $set: { bus: standardized } }); }
  // Expired passes must not remain marked active; otherwise the database uniqueness rule below
  // would block a legitimate renewal. Keep their records for history/auditing.
  const auditNow = new Date();
  await BusPass.updateMany({ status: "active", $or: [{ expiresAt: { $lt: auditNow } }, { expiresAt: { $exists: false } }, { stopId: { $exists: false } }, { username: { $exists: false } }] }, { $set: { status: "inactive" } });
  // Keep old records for auditing but deactivate duplicate overlapping passes for the same student + stop.
  const activePasses = await BusPass.find({ status: "active", paymentStatus: "paid", expiresAt: { $gte: auditNow } }).sort({ createdAt: 1, _id: 1 }).lean();
  const seenActivePasses = new Set();
  for (const pass of activePasses) {
    const key = `${pass.username}::${String(pass.stopId)}`;
    if (seenActivePasses.has(key)) await BusPass.updateOne({ _id: pass._id }, { $set: { status: "inactive" } });
    else seenActivePasses.add(key);
  }
  // Migrate drivers created by the earlier prototype into the dedicated drivers collection.
  const legacyDrivers = await User.find({ role: "driver" }).lean();
  for (const d of legacyDrivers) {
    await Driver.updateOne({ username: d.username }, { $setOnInsert: {
      userId: d._id, username: d.username, name: d.name, email: d.email || "", bus: d.bus || "BUS-01",
      verificationStatus: d.approved ? "verified" : "pending", verifiedAt: d.approved ? (d.updatedAt || new Date()) : null,
      verifiedBy: d.approved ? "Migrated existing admin-approved driver" : ""
    } }, { upsert: true });
  }
}

app.get("/", (req, res) => { if (req.session.user) return res.redirect("/dashboard"); res.render("login", { ...pageData(req), mode: "login" }); });
app.get("/signup", (req, res) => { if (req.session.user) return res.redirect("/dashboard"); res.render("login", { ...pageData(req), mode: "signup" }); });
app.post("/signup", async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim(); const username = String(req.body.username || "").trim().toLowerCase();
    const email = String(req.body.email || "").trim().toLowerCase(); const password = String(req.body.password || "");
    if (name.length < 2 || !/^[a-z0-9._-]{3,30}$/.test(username) || password.length < 8) {
      flash(req, "error", "Enter your name, a username (3–30 letters/numbers), and a password of at least 8 characters."); return res.redirect("/signup");
    }
    if (await User.exists({ username })) { flash(req, "error", "That username is already registered. Please choose another."); return res.redirect("/signup"); }
    const user = await User.create({ name, username, email, passwordHash: await bcrypt.hash(password, 12), role: "student", approved: true });
    setSessionUser(req, user); flash(req, "success", "Your student account has been created. Welcome to SmartBus!"); res.redirect("/dashboard");
  } catch (err) { if (err.code === 11000) { flash(req, "error", "That username is already taken."); return res.redirect("/signup"); } next(err); }
});
app.post("/login", async (req, res, next) => {
  try {
    const username = String(req.body.username || "").trim().toLowerCase(); const password = String(req.body.password || "");
    const user = await User.findOne({ username });
    if (!user || !user.approved || !(await bcrypt.compare(password, user.passwordHash))) { flash(req, "error", "Invalid login details or account not yet approved."); return res.redirect("/"); }
    setSessionUser(req, user); res.redirect("/dashboard");
  } catch (err) { next(err); }
});
app.get("/logout", (req, res) => req.session.destroy(() => res.redirect("/")));

app.get("/dashboard", requireLogin, async (req, res, next) => {
  try {
    const role = req.session.user.role; const stops = await Stop.find({ active: true }).sort({ name: 1 }).lean();
    let passes = [], payments = [], drivers = [], students = [];
    if (role === "student") { passes = await BusPass.find({ username: req.session.user.username }).sort({ createdAt: -1 }).lean(); payments = await Payment.find({ username: req.session.user.username }).sort({ createdAt: -1 }).limit(20).lean(); }
    if (role === "admin") { passes = await BusPass.find().sort({ createdAt: -1 }).limit(200).lean(); payments = await Payment.find().sort({ createdAt: -1 }).limit(200).lean(); drivers = await Driver.find().sort({ createdAt: -1 }).lean(); students = await User.find({ role: "student" }).sort({ createdAt: -1 }).limit(200).lean(); }
    res.render("dashboard", { ...pageData(req), role, stops, passes, payments, drivers, students, busNumbers: BUS_NUMBERS, renewRequestKey: role === "student" ? crypto.randomBytes(24).toString("hex") : "" });
  } catch (err) { next(err); }
});

app.post("/renew", requireRole("student"), async (req, res, next) => {
  try {
    const requestKey = String(req.body.request_key || "").trim();
    if (!/^[a-f0-9]{48}$/.test(requestKey)) { flash(req, "error", "This payment form has expired. Refresh the dashboard and try again."); return res.redirect("/dashboard"); }

    // Idempotency: a repeated click or browser retry using the same form token cannot issue a second pass.
    const previousAttempt = await Payment.findOne({ requestKey }).lean();
    if (previousAttempt) {
      flash(req, "success", previousAttempt.status === "paid" ? "This payment was already processed; no duplicate pass was created." : previousAttempt.status === "processing" ? "This payment is already being processed. Refresh in a moment." : "This payment attempt was already recorded; no duplicate attempt was created.");
      return res.redirect("/dashboard");
    }

    const stop = await Stop.findOne({ _id: req.body.stop_id, active: true });
    if (!stop) { flash(req, "error", "Please select a valid boarding point."); return res.redirect("/dashboard"); }
    const successful = req.body.payment_result === "success";
    const now = new Date();
    // Expire stale records for this student/stop before checking or inserting. The unique partial
    // index below protects against concurrent requests even when they use different form tokens.
    if (successful) {
      await BusPass.updateMany({ username: req.session.user.username, stopId: stop._id, status: "active", expiresAt: { $lt: now } }, { $set: { status: "inactive" } });
      const existingActive = await BusPass.findOne({ username: req.session.user.username, stopId: stop._id, status: "active", paymentStatus: "paid", expiresAt: { $gte: now } }).sort({ createdAt: 1 }).lean();
      if (existingActive) {
        flash(req, "error", `You already have an active pass for ${stop.name} until ${new Date(existingActive.expiresAt).toISOString().slice(0, 10)}. Your existing pass is still available below.`);
        return res.redirect("/dashboard");
      }
    }

    const transactionId = "SB-" + crypto.randomBytes(6).toString("hex").toUpperCase();
    // Reserve the unique request key before creating a pass. Concurrent duplicate POSTs hit this unique key first.
    let payment;
    try {
      payment = await Payment.create({ requestKey, transactionId, username: req.session.user.username, studentName: req.session.user.name, stopName: stop.name, bus: normalizeBus(stop.bus), amount: stop.fare, status: successful ? "processing" : "failed", method: "Demo payment", paidAt: now, passId: null });
    } catch (err) {
      if (err.code === 11000) { flash(req, "success", "This payment form was already submitted; duplicate processing was blocked."); return res.redirect("/dashboard"); }
      throw err;
    }

    if (successful) {
      let issuedPass = null;
      try {
        const student = await User.findById(req.session.user.id).lean();
        const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        issuedPass = await BusPass.create({ username: req.session.user.username, studentName: req.session.user.name, studentEmail: student?.email || "", stopId: stop._id, stopName: stop.name, bus: normalizeBus(stop.bus), transactionId, amount: stop.fare, paymentStatus: "paid", createdAt: now, expiresAt });
        payment.passId = issuedPass._id;
        payment.status = "paid";
        await payment.save();
        flash(req, "success", `Payment recorded. Your 30-day pass is ready; assigned bus: ${normalizeBus(stop.bus)}.`);
      } catch (issuanceError) {
        // Compensate if pass creation or payment linking fails, so we don't leave an active
        // orphan pass or a payment stuck in "processing". This is a demo payment, not a charge.
        if (issuedPass?._id) await BusPass.updateOne({ _id: issuedPass._id }, { $set: { status: "inactive" } }).catch(() => {});
        await Payment.updateOne({ _id: payment._id }, { $set: { status: "failed", method: issuanceError.code === 11000 ? "Demo payment - duplicate pass blocked" : "Demo payment - pass issuance failed" } }).catch(() => {});
        if (issuanceError.code === 11000) {
          const currentPass = await BusPass.findOne({ username: req.session.user.username, stopId: stop._id, status: "active", paymentStatus: "paid", expiresAt: { $gte: new Date() } }).lean();
          flash(req, "error", currentPass ? `You already have an active pass for ${stop.name}. No duplicate pass was created.` : "A duplicate pass submission was blocked. Please refresh and check your passes.");
          return res.redirect("/dashboard");
        }
        throw issuanceError;
      }
    } else {
      flash(req, "error", "Demo payment failed. The failed attempt was recorded; no pass was issued.");
    }
    res.redirect("/dashboard");
  } catch (err) { next(err); }
});
app.get("/pass/:id/qr.png", requireLogin, async (req, res, next) => {
  try {
    const pass = await BusPass.findById(req.params.id).lean();
    if (!pass || (req.session.user.role === "student" && pass.username !== req.session.user.username) || (req.session.user.role === "driver" && pass.bus !== req.session.user.bus)) return res.status(404).send("Pass not found");
    const payload = JSON.stringify({ issuer: "SmartBus College Transport", passId: pass._id.toString(), transactionId: pass.transactionId, username: pass.username, studentName: pass.studentName, boardingPoint: pass.stopName, bus: pass.bus, amount: pass.amount, status: pass.status, paymentStatus: pass.paymentStatus, expiresAt: new Date(pass.expiresAt).toISOString() });
    res.type("png").send(await QRCode.toBuffer(payload, { type: "png", width: 360, margin: 2, errorCorrectionLevel: "H" }));
  } catch (err) { next(err); }
});
app.post("/verify", requireRole("driver"), async (req, res, next) => {
  try {
    const code = String(req.body.code || "").trim(); let pass = null; let qr = null;
    if (code.startsWith("{")) { try { qr = JSON.parse(code); } catch {} }
    if (qr?.passId && mongoose.isValidObjectId(qr.passId)) pass = await BusPass.findById(qr.passId).lean();
    if (!pass && mongoose.isValidObjectId(code)) pass = await BusPass.findById(code).lean();
    if (!pass) pass = await BusPass.findOne({ transactionId: qr?.transactionId || code }).lean();
    if (!pass) return res.json({ ok: false, message: "Pass not found. Enter the pass ID or transaction ID." });
    const expired = new Date(pass.expiresAt) < new Date();
    if (pass.bus !== (req.session.user.bus || "")) return res.json({ ok: false, message: "This pass is assigned to a different bus.", name: pass.studentName, stop: pass.stopName, bus: pass.bus });
    if (expired || pass.status !== "active" || pass.paymentStatus !== "paid") return res.json({ ok: false, message: "Pass is expired or inactive.", name: pass.studentName, stop: pass.stopName, bus: pass.bus });
    res.json({ ok: true, message: "Valid pass", name: pass.studentName, username: pass.username, stop: pass.stopName, bus: pass.bus, expires: new Date(pass.expiresAt).toISOString().slice(0, 10), transaction: pass.transactionId, amount: pass.amount });
  } catch (err) { next(err); }
});
app.post("/location", requireRole("driver"), async (req, res, next) => {
  try { const lat = Number(req.body.lat), lng = Number(req.body.lng); if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return res.status(400).json({ ok: false, message: "Invalid coordinates" });
    await BusLocation.findOneAndUpdate({ username: req.session.user.username }, { $set: { bus: req.session.user.bus, lat, lng, updatedAt: new Date() } }, { upsert: true, new: true, runValidators: true }); res.json({ ok: true });
  } catch (err) { next(err); }
});
app.get("/location", requireRole("student"), async (req, res, next) => { try { const activePass = await BusPass.findOne({ username: req.session.user.username, status: "active", expiresAt: { $gte: new Date() } }).sort({ createdAt: -1 }).lean(); const bus = activePass?.bus; if (!bus) return res.json({ available: false, message: "Renew a pass to see your assigned bus location." }); const location = await BusLocation.findOne({ bus }).sort({ updatedAt: -1 }).lean(); res.json(location ? { ...location, available: true } : { available: false, bus, message: "Your driver has not shared a location yet." }); } catch (err) { next(err); } });

app.post("/stops/add", requireRole("admin"), async (req, res, next) => {
  try { const name = String(req.body.name || "").trim(); const fare = Number(req.body.fare); const bus = String(req.body.bus || "").trim().toUpperCase(); if (name.length < 2 || !Number.isFinite(fare) || fare < 0 || !isStandardBus(bus)) { flash(req, "error", "Enter a boarding point, valid fare, and a standard bus number (BUS-01 to BUS-10)."); return res.redirect("/dashboard"); } await Stop.create({ name, fare, bus }); flash(req, "success", "Boarding point added."); res.redirect("/dashboard"); }
  catch (err) { if (err.code === 11000) { flash(req, "error", "A boarding point with that name already exists."); return res.redirect("/dashboard"); } next(err); }
});
app.post("/stops/update", requireRole("admin"), async (req, res, next) => {
  try { const stopId = String(req.body.stop_id || ""); const fare = Number(req.body.fare); const version = Number(req.body.version); const bus = String(req.body.bus || "").trim().toUpperCase(); const name = String(req.body.name || "").trim(); if (!mongoose.isValidObjectId(stopId) || !Number.isFinite(fare) || fare < 0 || !Number.isInteger(version) || !isStandardBus(bus) || name.length < 2) { flash(req, "error", "Enter valid boarding point details and select a standard bus number (BUS-01 to BUS-10)."); return res.redirect("/dashboard"); }
    const updated = await Stop.findOneAndUpdate({ _id: stopId, version }, { $set: { fare, bus, name }, $inc: { version: 1 } }, { new: true, runValidators: true }); flash(req, updated ? "success" : "error", updated ? "Boarding point, fare and bus assignment updated." : "This point was edited in another session. Refresh and try again."); res.redirect("/dashboard");
  } catch (err) { if (err.code === 11000) { flash(req, "error", "That boarding point name is already in use."); return res.redirect("/dashboard"); } next(err); }
});
app.post("/drivers/add", requireRole("admin"), async (req, res, next) => {
  let createdDriverUser = null;
  try { const name = String(req.body.name || "").trim(); const username = String(req.body.username || "").trim().toLowerCase(); const email = String(req.body.email || "").trim().toLowerCase(); const password = String(req.body.password || ""); const bus = String(req.body.bus || "").trim().toUpperCase();
    if (name.length < 2 || !/^[a-z0-9._-]{3,30}$/.test(username) || password.length < 8 || !isStandardBus(bus)) { flash(req, "error", "Enter driver name, valid username, password of at least 8 characters, and select a standard bus number (BUS-01 to BUS-10)."); return res.redirect("/dashboard"); }
    createdDriverUser = await User.create({ name, username, email, passwordHash: await bcrypt.hash(password, 12), role: "driver", bus, approved: false });
    await Driver.create({ userId: createdDriverUser._id, name, username, email, bus, verificationStatus: "pending" });
    flash(req, "success", `Driver record created for ${bus}. Review the driver in the Drivers collection and click Verify driver before they can log in.`); res.redirect("/dashboard");
  } catch (err) {
    // If the driver profile insert fails after the login account was inserted, roll back the orphan account.
    if (createdDriverUser?._id) await User.deleteOne({ _id: createdDriverUser._id, role: "driver", approved: false }).catch(() => {});
    if (err.code === 11000) { flash(req, "error", "That username already exists or the driver profile already exists. No partial login account was kept."); return res.redirect("/dashboard"); }
    next(err);
  }
});
app.post("/drivers/:id/verify", requireRole("admin"), async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) { flash(req, "error", "Invalid driver record."); return res.redirect("/dashboard"); }
    const driver = await Driver.findById(req.params.id);
    if (!driver) { flash(req, "error", "Driver record not found."); return res.redirect("/dashboard"); }
    const user = await User.findById(driver.userId);
    if (!user || user.role !== "driver") { flash(req, "error", "Linked driver login was not found."); return res.redirect("/dashboard"); }
    driver.verificationStatus = "verified"; driver.verifiedAt = new Date(); driver.verifiedBy = req.session.user.username;
    await driver.save(); user.approved = true; await user.save();
    flash(req, "success", `Driver ${driver.name} verified. Their login is now enabled.`); res.redirect("/dashboard");
  } catch (err) { next(err); }
});
app.post("/drivers/:id/revoke", requireRole("admin"), async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) { flash(req, "error", "Invalid driver record."); return res.redirect("/dashboard"); }
    const driver = await Driver.findById(req.params.id);
    if (!driver) { flash(req, "error", "Driver record not found."); return res.redirect("/dashboard"); }
    driver.verificationStatus = "rejected"; driver.verifiedAt = null; driver.verifiedBy = req.session.user.username; await driver.save();
    await User.updateOne({ _id: driver.userId, role: "driver" }, { $set: { approved: false } });
    flash(req, "success", `Driver ${driver.name} is unverified and their login is disabled.`); res.redirect("/dashboard");
  } catch (err) { next(err); }
});

app.use((err, req, res, next) => { console.error(err); if (res.headersSent) return next(err); res.status(500).send('<main style="font-family:system-ui;max-width:720px;margin:60px auto;padding:20px"><h1>SmartBus encountered an error</h1><p>Check the VS Code terminal. Ensure MongoDB is running and your MONGO_URI is correct.</p><p><a href="/dashboard">Return to dashboard</a></p></main>'); });
mongoose.connect(MONGO_URI).then(async () => { console.log("Connected to MongoDB"); await seedDatabase();
  // Enforce the active-pass rule at the database level as well as in route logic. This closes
  // the race where two separate tabs submit different form tokens at nearly the same time.
  await BusPass.collection.createIndex(
    { username: 1, stopId: 1 },
    { unique: true, partialFilterExpression: { status: "active", paymentStatus: "paid" }, name: "one_active_paid_pass_per_student_stop" }
  );
  // Create an empty drivers collection too, so admins can see the dedicated collection in Compass before adding the first driver.
  try { await mongoose.connection.db.createCollection("drivers"); } catch (err) { if (err.codeName !== "NamespaceExists" && err.code !== 48) throw err; }
  app.listen(PORT, () => console.log(`SmartBus running at http://localhost:${PORT}`)); }).catch(err => { console.error("MongoDB connection failed:", err.message); process.exit(1); });
