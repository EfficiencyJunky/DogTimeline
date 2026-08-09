(function () {
  var DATA = window.__TIMELINE_DATA__ || { breeds: [], undated: [] };
  var breeds = DATA.breeds;

  var svgNS = "http://www.w3.org/2000/svg";
  var svg = document.getElementById("chart");

  // ---- layout constants (logical SVG units; viewBox scales this to fit) ----
  var MARGIN_L = 60, MARGIN_R = 60, MARGIN_TOP = 40;
  var PX_PER_TICK_GROUP = 340;   // controls overall logical width
  var LANE_HEIGHT = 28;
  var STEM_BASE = 24;
  var RADIUS = 9;
  var MIN_GAP = 112; // wide enough for a typical breed-name label, not just the circle

  var DOMAIN_MAX = 50000;  // years ago, per project spec
  var DOMAIN_MIN = 10;

  var TICKS = [50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10];

  function fmtYbp(y) {
    if (y >= 1000) return (y / 1000) + "k ya";
    return y + " ya";
  }

  function logT(ybp) {
    var clamped = Math.max(DOMAIN_MIN, Math.min(DOMAIN_MAX, ybp));
    return (Math.log10(DOMAIN_MAX) - Math.log10(clamped)) /
           (Math.log10(DOMAIN_MAX) - Math.log10(DOMAIN_MIN));
  }

  var LOGICAL_WIDTH = MARGIN_L + MARGIN_R + PX_PER_TICK_GROUP * (TICKS.length - 1);

  function xOf(ybp) {
    return MARGIN_L + logT(ybp) * (LOGICAL_WIDTH - MARGIN_L - MARGIN_R);
  }

  // ---- lane packing so circles don't overlap ----
  var sorted = breeds.slice().sort(function (a, b) { return xOf(a.years_before_present) - xOf(b.years_before_present); });
  var laneLastX = [];
  sorted.forEach(function (b) {
    var x = xOf(b.years_before_present);
    var lane = 0;
    while (laneLastX[lane] !== undefined && x - laneLastX[lane] < MIN_GAP) lane++;
    laneLastX[lane] = x;
    b._lane = lane;
    b._x = x;
  });
  var maxLane = laneLastX.length - 1;
  var AXIS_Y = MARGIN_TOP + (maxLane + 1) * LANE_HEIGHT + STEM_BASE;
  var LOGICAL_HEIGHT = AXIS_Y + 70;

  svg.setAttribute("viewBox", "0 0 " + LOGICAL_WIDTH + " " + LOGICAL_HEIGHT);
  svg.setAttribute("width", LOGICAL_WIDTH);
  svg.setAttribute("height", LOGICAL_HEIGHT);

  function el(tag, attrs) {
    var e = document.createElementNS(svgNS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  // axis
  svg.appendChild(el("line", { x1: MARGIN_L, y1: AXIS_Y, x2: LOGICAL_WIDTH - MARGIN_R, y2: AXIS_Y, class: "axis-line" }));

  TICKS.forEach(function (t) {
    var x = xOf(t);
    svg.appendChild(el("line", { x1: x, y1: MARGIN_TOP - 10, x2: x, y2: AXIS_Y, class: "gridline" }));
    var label = el("text", { x: x, y: AXIS_Y + 20, class: "tick-label", "text-anchor": "middle" });
    label.textContent = t === 10 ? "Today" : fmtYbp(t);
    svg.appendChild(label);
  });

  // markers
  var markerNodes = {};
  sorted.forEach(function (b) {
    var y = AXIS_Y - STEM_BASE - b._lane * LANE_HEIGHT;
    var g = el("g", { "data-key": b.key });

    g.appendChild(el("line", { x1: b._x, y1: AXIS_Y, x2: b._x, y2: y, class: "stem" }));
    var circle = el("circle", { cx: b._x, cy: y, r: RADIUS, class: "marker " + b.confidence_tier });
    g.appendChild(circle);

    var label = el("text", {
      x: b._x, y: y - RADIUS - 5, class: "marker-label", "text-anchor": "middle"
    });
    label.textContent = b.name.length > 20 ? b.name.slice(0, 18) + "…" : b.name;
    g.appendChild(label);

    g.addEventListener("mouseenter", function (ev) { showTooltip(b, ev); });
    g.addEventListener("mousemove", function (ev) { moveTooltip(ev); });
    g.addEventListener("mouseleave", hideTooltip);
    g.addEventListener("click", function () { openDetail(b); });

    svg.appendChild(g);
    markerNodes[b.key] = { g: g, circle: circle, label: label };
  });

  // ---- tooltip ----
  var tooltip = document.getElementById("tooltip");
  function showTooltip(b, ev) {
    tooltip.innerHTML =
      '<div class="name">' + escapeHtml(b.name) + '</div>' +
      '<div class="date">' + escapeHtml(b.estimate_value_raw) + ' &middot; ' + fmtYbp(b.years_before_present) + '</div>' +
      '<div class="note">' + escapeHtml(truncate(b.estimate_note, 160)) + '</div>';
    tooltip.style.display = "block";
    moveTooltip(ev);
  }
  function moveTooltip(ev) {
    var pad = 16;
    var x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + 300 > window.innerWidth) x = ev.clientX - 300 - pad;
    tooltip.style.left = x + "px";
    tooltip.style.top = y + "px";
  }
  function hideTooltip() { tooltip.style.display = "none"; }

  // ---- detail panel ----
  var detail = document.getElementById("detail");
  var detailBody = document.getElementById("detail-body");
  document.getElementById("detail-close").addEventListener("click", function () {
    detail.classList.remove("open");
  });
  function openDetail(b) {
    detailBody.innerHTML =
      '<h2>' + escapeHtml(b.name) + '</h2>' +
      '<div class="sub" style="color:var(--muted);font-size:12px">' + escapeHtml(b.origin_country || "") + '</div>' +
      field("Origin estimate", escapeHtml(b.estimate_value_raw) + ' (' + escapeHtml(b.estimate_type) + ')') +
      field("Confidence", escapeHtml(b.confidence_tier)) +
      field("Estimate note", escapeHtml(b.estimate_note)) +
      (b.recognition_year ? field("Recognition year", escapeHtml(b.recognition_year)) : "") +
      (b.notes ? field("Notes", escapeHtml(b.notes)) : "") +
      field("Primary source", '<a href="' + escapeAttr(b.primary_source_url) + '" target="_blank" rel="noopener">' +
            escapeHtml(b.primary_source_registry || b.primary_source_url) + '</a>');
    detail.classList.add("open");
  }
  function field(label, html) {
    return '<div class="field"><div class="field-label">' + label + '</div><div>' + html + '</div></div>';
  }

  // ---- search ----
  var searchInput = document.getElementById("search");
  searchInput.addEventListener("input", function () {
    var q = searchInput.value.trim().toLowerCase();
    breeds.forEach(function (b) {
      var nodes = markerNodes[b.key];
      var match = !q || b.name.toLowerCase().indexOf(q) !== -1;
      nodes.circle.classList.toggle("dim", !match);
      nodes.label.classList.toggle("dim", !match);
      nodes.circle.classList.toggle("hot", !!q && match);
    });
  });

  // ---- undated list ----
  var undated = DATA.undated || [];
  document.getElementById("undated-sub").textContent =
    undated.length + " researched breed" + (undated.length === 1 ? "" : "s") +
    " have no date estimate yet (origin_estimate_type: none) — not shown on the timeline above.";
  var undatedList = document.getElementById("undated-list");
  undated.forEach(function (u) {
    var chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = u.name;
    undatedList.appendChild(chip);
  });

  // ---- header ----
  document.getElementById("header-sub").textContent =
    breeds.length + " breeds plotted, " + undated.length + " undated " +
    "(" + (breeds.length + undated.length) + " of ~628 in the full breed dataset researched so far).";

  // ---- utils ----
  function truncate(s, n) { s = s || ""; return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function escapeAttr(s) { return escapeHtml(s); }
})();
