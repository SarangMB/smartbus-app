const stopSelect = document.getElementById("stop-select");
if (stopSelect) {
  const showFare = () => {
    const opt = stopSelect.options[stopSelect.selectedIndex];
    document.getElementById("fare-display").textContent = opt?.dataset?.fare ? `₹${Number(opt.dataset.fare).toFixed(2)}` : "₹0.00";
    const busDisplay = document.getElementById("bus-display");
    if (busDisplay) busDisplay.textContent = opt?.dataset?.bus ? `Assigned bus: ${opt.dataset.bus}` : "Bus assigned after selection";
  };
  stopSelect.addEventListener("change", showFare);
  showFare();
}

const verifyForm = document.getElementById("verify-form");
if (verifyForm) verifyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const result = document.getElementById("verify-result");
  result.classList.remove("hidden", "ok", "bad");
  result.textContent = "Checking pass…";
  try {
    const res = await fetch("/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: document.getElementById("verify-code").value })
    });
    const data = await res.json();
    result.classList.add(data.ok ? "ok" : "bad");
    const addLine = (label, value) => {
      if (!value) return "";
      const p = document.createElement("p");
      p.textContent = `${label}: ${value}`;
      result.appendChild(p);
    };
    result.replaceChildren();
    const strong = document.createElement("strong");
    strong.textContent = `${data.ok ? "✓ " : "⚠ "}${data.message}`;
    result.appendChild(strong);
    addLine("Student", data.name);
    addLine("Boarding point", data.stop);
    addLine("Assigned bus", data.bus);
    addLine("Valid until", data.expires);
    addLine("Transaction", data.transaction);
    if (data.amount !== undefined) addLine("Paid", `₹${Number(data.amount).toFixed(2)}`);
  } catch {
    result.classList.add("bad");
    result.textContent = "Could not verify right now. Try again.";
  }
});

// One-time current-location sharing and real OpenStreetMap display via Leaflet.
function createLocationMap(elementId, lat = 20, lng = 0, zoom = 2) {
  const el = document.getElementById(elementId);
  if (!el || !window.L) return null;
  const map = L.map(el).setView([lat, lng], zoom);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  return { map, marker: null };
}
function showLocationOnMap(mapState, lat, lng, label) {
  if (!mapState) return;
  const point = [Number(lat), Number(lng)];
  mapState.map.setView(point, 16);
  if (mapState.marker) mapState.marker.setLatLng(point).bindPopup(label);
  else mapState.marker = L.marker(point).addTo(mapState.map).bindPopup(label);
  mapState.marker.openPopup();
  setTimeout(() => mapState.map.invalidateSize(), 50);
}

const startBtn = document.getElementById("start-location");
if (startBtn) {
  const driverMap = createLocationMap("driver-location-map");
  startBtn.addEventListener("click", () => {
    const status = document.getElementById("driver-location-status");
    const coordinates = document.getElementById("driver-location-coordinates");
    if (!navigator.geolocation) { status.textContent = "This browser does not support location access."; return; }
    status.textContent = "Requesting permission to get your current location…";
    startBtn.disabled = true;
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      try {
        const response = await fetch("/location", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lat, lng })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.message || "Could not save the location.");
        status.textContent = "Current location shared successfully.";
        coordinates.textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)} · Accuracy ±${Math.round(pos.coords.accuracy)} m`;
        showLocationOnMap(driverMap, lat, lng, "Your current location");
        startBtn.textContent = "Share my current location again";
      } catch (err) {
        status.textContent = err.message || "Could not save your location. Try again.";
      } finally { startBtn.disabled = false; }
    }, (err) => {
      const messages = { 1: "Location permission was denied. Allow location access in your browser settings.", 2: "Your device could not determine a location. Try again outdoors or check GPS settings.", 3: "Location request timed out. Please try again." };
      status.textContent = messages[err.code] || err.message || "Unable to get location.";
      startBtn.disabled = false;
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  });
}

const refreshBtn = document.getElementById("refresh-location");
if (refreshBtn) {
  const studentMap = createLocationMap("student-location-map");
  const status = document.getElementById("location-status");
  const coordinates = document.getElementById("location-coordinates");
  const updated = document.getElementById("location-updated");
  const loadLatestLocation = async () => {
    status.textContent = "Loading latest shared location…";
    try {
      const res = await fetch("/location", { headers: { Accept: "application/json" } });
      const data = await res.json();
      if (data.lat == null || data.lng == null) {
        status.textContent = data.message || "Your driver has not shared a location yet.";
        coordinates.textContent = "No coordinates available";
        updated.textContent = "";
        return;
      }
      status.textContent = `Latest location for ${data.bus || "your assigned bus"}`;
      coordinates.textContent = `${Number(data.lat).toFixed(6)}, ${Number(data.lng).toFixed(6)}`;
      updated.textContent = data.updatedAt ? `Last shared: ${new Date(data.updatedAt).toLocaleString()}` : "Location received";
      showLocationOnMap(studentMap, data.lat, data.lng, `${data.bus || "Bus"} current location`);
    } catch { status.textContent = "Unable to load location. Please try again."; }
  };
  refreshBtn.addEventListener("click", loadLatestLocation);
  loadLatestLocation();
}


// Prevent accidental double-clicks on the payment simulation form; server-side idempotency remains authoritative.
const renewForm = document.getElementById("renew-form");
if (renewForm) {
  renewForm.addEventListener("submit", () => {
    const button = document.getElementById("renew-submit");
    if (button) { button.disabled = true; button.textContent = "Processing payment…"; }
  }, { once: true });
}
