(function () {
  var DATA = window.__TIMELINE_DATA__ || { breeds: [], undated: [] };
  var breeds = DATA.breeds || [];
  var undated = DATA.undated || [];

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

  function el(tag, attrs) {
    var e = document.createElementNS(svgNS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  // 5-pointed star polygon, same visual footprint as the circle marker it replaces.
  function starPoints(cx, cy, outerR, innerR) {
    var pts = [];
    for (var i = 0; i < 10; i++) {
      var angle = (Math.PI / 5) * i - Math.PI / 2;
      var r = i % 2 === 0 ? outerR : innerR;
      pts.push((cx + r * Math.cos(angle)).toFixed(2) + "," + (cy + r * Math.sin(angle)).toFixed(2));
    }
    return pts.join(" ");
  }

  // Diamond, used for the ancestor (MRCA) node so it reads as distinct from its descendants.
  function diamondPoints(cx, cy, r) {
    return [cx + "," + (cy - r), (cx + r) + "," + cy, cx + "," + (cy + r), (cx - r) + "," + cy].join(" ");
  }

  // ---- ancestor-lineage (MRCA) dataset, derived from breeds+undated at load time ----
  function buildAncestorDataset() {
    var all = breeds.concat(undated);
    var out = [];
    all.forEach(function (b) {
      if (!b.mrca) return;
      out.push({
        key: b.key,
        name: b.name,
        also_known_as: b.also_known_as,
        origin_country: b.origin_country,
        estimate_type: b.mrca.estimate_type,
        estimate_value_raw: b.mrca.estimate_value_raw,
        origin_estimate_basis: "direct",
        estimate_note: b.mrca.estimate_note,
        recognition_year: b.recognition_year,
        confidence_tier: b.confidence_tier || "anchor",
        notes: b.notes,
        primary_source_registry: b.primary_source_registry,
        primary_source_url: b.primary_source_url,
        years_before_present: b.mrca.years_before_present,
        favorite: b.favorite,
        ancestor_lineage_name: b.mrca.name,
        lineage_id: b.mrca.lineage_id,
        source_citation: b.mrca.source_citation,
        source_url: b.mrca.source_url
      });
    });
    return out;
  }

  // Group flat ancestor-view records back into one cluster per shared lineage_id,
  // so multiple breeds tracing to the same MRCA render as one ancestor node with
  // its descendants fanned out below it, instead of N independent markers.
  function groupByLineage(items) {
    var map = {}, order = [];
    items.forEach(function (b) {
      var id = b.lineage_id;
      if (!map[id]) {
        map[id] = {
          lineage_id: id,
          name: b.ancestor_lineage_name,
          estimate_type: b.estimate_type,
          estimate_value_raw: b.estimate_value_raw,
          estimate_note: b.estimate_note,
          source_citation: b.source_citation,
          source_url: b.source_url,
          years_before_present: b.years_before_present,
          members: []
        };
        order.push(id);
      }
      map[id].members.push(b);
    });
    return order.map(function (id) { return map[id]; });
  }

  var ancestorBreeds = buildAncestorDataset();
  var noAncestorBreeds = breeds.concat(undated).filter(function (b) { return !b.mrca; });
  var FAN_RISE = 55;     // vertical distance from the descendant row up to the ancestor node
  var FAN_SPACING = 90;  // horizontal spacing between fanned-out descendant markers

  // ---- mode state ----
  var mode = "founding"; // "founding" | "ancestor"
  var currentBreeds = breeds;
  var markerNodes = {};

  // ---- render (called at load, and again whenever the mode toggle changes) ----
  // Sorts by x and assigns non-overlapping lanes (0 = closest to axis). Mutates
  // each item with ._x/._lane and returns the max lane index used (-1 if empty).
  function packLanes(items) {
    var sorted = items.slice().sort(function (a, b) { return xOf(a.years_before_present) - xOf(b.years_before_present); });
    var laneLastX = [];
    sorted.forEach(function (b) {
      var x = xOf(b.years_before_present);
      var lane = 0;
      while (laneLastX[lane] !== undefined && x - laneLastX[lane] < MIN_GAP) lane++;
      laneLastX[lane] = x;
      b._lane = lane;
      b._x = x;
    });
    return { sorted: sorted, maxLane: laneLastX.length - 1 };
  }

  function renderView(activeBreeds) {
    currentBreeds = activeBreeds;
    markerNodes = {};
    svg.innerHTML = "";

    // Bisected layout: rich-confidence breeds above the axis, anchor/vague below --
    // two independent lane-packing passes since the two groups never need to
    // avoid each other (they're in separate vertical bands).
    var above = packLanes(activeBreeds.filter(function (b) { return b.confidence_tier === "rich"; }));
    var below = packLanes(activeBreeds.filter(function (b) { return b.confidence_tier !== "rich"; }));

    var TICK_MARGIN = 24; // reserved space for tick date labels, top and bottom
    var axisY = TICK_MARGIN + (above.maxLane + 1) * LANE_HEIGHT + STEM_BASE;
    var gridBottomY = axisY + (below.maxLane + 1) * LANE_HEIGHT + STEM_BASE;
    var logicalHeight = gridBottomY + TICK_MARGIN;

    svg.setAttribute("viewBox", "0 0 " + LOGICAL_WIDTH + " " + logicalHeight);
    svg.setAttribute("width", LOGICAL_WIDTH);
    svg.setAttribute("height", logicalHeight);

    svg.appendChild(el("line", { x1: MARGIN_L, y1: axisY, x2: LOGICAL_WIDTH - MARGIN_R, y2: axisY, class: "axis-line" }));

    TICKS.forEach(function (t) {
      var x = xOf(t);
      svg.appendChild(el("line", { x1: x, y1: TICK_MARGIN - 14, x2: x, y2: gridBottomY + 14, class: "gridline" }));
      var text = t === 10 ? "Today" : fmtYbp(t);
      var topLabel = el("text", { x: x, y: 16, class: "tick-label", "text-anchor": "middle" });
      topLabel.textContent = text;
      svg.appendChild(topLabel);
      var bottomLabel = el("text", { x: x, y: gridBottomY + 34, class: "tick-label", "text-anchor": "middle" });
      bottomLabel.textContent = text;
      svg.appendChild(bottomLabel);
    });

    function renderGroup(group, sign) {
      group.sorted.forEach(function (b) {
        var y = axisY + sign * (STEM_BASE + b._lane * LANE_HEIGHT);
        var g = el("g", { "data-key": b.key });

        g.appendChild(el("line", { x1: b._x, y1: axisY, x2: b._x, y2: y, class: "stem" }));
        var markerClass = "marker " + b.confidence_tier + (b.favorite ? " favorite" : "");
        var marker = b.favorite
          ? el("polygon", { points: starPoints(b._x, y, RADIUS * 1.35, RADIUS * 1.35 * 0.45), class: markerClass })
          : el("circle", { cx: b._x, cy: y, r: RADIUS, class: markerClass });
        g.appendChild(marker);

        var label = el("text", {
          x: b._x, y: sign < 0 ? y - RADIUS - 5 : y + RADIUS + 16, class: "marker-label", "text-anchor": "middle"
        });
        label.textContent = b.name.length > 20 ? b.name.slice(0, 18) + "…" : b.name;
        g.appendChild(label);

        g.addEventListener("mouseenter", function (ev) { showTooltip(b, ev); });
        g.addEventListener("mousemove", function (ev) { moveTooltip(ev); });
        g.addEventListener("mouseleave", hideTooltip);
        g.addEventListener("click", function () { openDetail(b); });

        svg.appendChild(g);
        markerNodes[b.key] = { g: g, circle: marker, label: label };
      });
    }

    renderGroup(above, -1);
    renderGroup(below, 1);

    applySearch();
  }

  // ---- ancestor (MRCA) view: one trunk+diamond node per lineage, descendants fanned below ----
  function renderAncestorClusters(items) {
    currentBreeds = items;
    markerNodes = {};
    svg.innerHTML = "";

    var clusters = groupByLineage(items);
    clusters.forEach(function (c) { c._x = xOf(c.years_before_present); });
    var sorted = clusters.slice().sort(function (a, b) { return a._x - b._x; });

    var laneRightEdge = [];
    sorted.forEach(function (c) {
      var halfWidth = (c.members.length - 1) * FAN_SPACING / 2 + MIN_GAP / 2;
      var lane = 0;
      while (laneRightEdge[lane] !== undefined && (c._x - halfWidth) < laneRightEdge[lane]) lane++;
      laneRightEdge[lane] = c._x + halfWidth;
      c._lane = lane;
    });
    var maxLane = laneRightEdge.length - 1;
    var axisY = MARGIN_TOP + (maxLane + 1) * LANE_HEIGHT + STEM_BASE + FAN_RISE;
    var logicalHeight = axisY + 70;

    svg.setAttribute("viewBox", "0 0 " + LOGICAL_WIDTH + " " + logicalHeight);
    svg.setAttribute("width", LOGICAL_WIDTH);
    svg.setAttribute("height", logicalHeight);

    svg.appendChild(el("line", { x1: MARGIN_L, y1: axisY, x2: LOGICAL_WIDTH - MARGIN_R, y2: axisY, class: "axis-line" }));
    TICKS.forEach(function (t) {
      var x = xOf(t);
      svg.appendChild(el("line", { x1: x, y1: MARGIN_TOP - 10, x2: x, y2: axisY, class: "gridline" }));
      var label = el("text", { x: x, y: axisY + 20, class: "tick-label", "text-anchor": "middle" });
      label.textContent = t === 10 ? "Today" : fmtYbp(t);
      svg.appendChild(label);
    });

    sorted.forEach(function (c) {
      var descendantY = axisY - STEM_BASE - c._lane * LANE_HEIGHT;
      var ancestorY = descendantY - FAN_RISE;

      // trunk: the one line actually anchored to the real date on the axis
      svg.appendChild(el("line", { x1: c._x, y1: axisY, x2: c._x, y2: ancestorY, class: "stem trunk" }));

      // ancestor (MRCA) node
      var ancestorG = el("g", { "data-lineage": c.lineage_id });
      var ancestorMarker = el("polygon", {
        points: diamondPoints(c._x, ancestorY, RADIUS * 1.7),
        class: "marker ancestor-node"
      });
      ancestorG.appendChild(ancestorMarker);
      var ancestorLabel = el("text", {
        x: c._x, y: ancestorY - RADIUS * 1.7 - 6, class: "marker-label ancestor-label", "text-anchor": "middle"
      });
      ancestorLabel.textContent = c.name;
      ancestorG.appendChild(ancestorLabel);
      ancestorG.addEventListener("mouseenter", function (ev) { showAncestorTooltip(c, ev); });
      ancestorG.addEventListener("mousemove", function (ev) { moveTooltip(ev); });
      ancestorG.addEventListener("mouseleave", hideTooltip);
      ancestorG.addEventListener("click", function () { openAncestorDetail(c); });
      svg.appendChild(ancestorG);

      // descendants, fanned out below the ancestor, each linked to it by a branch line
      var n = c.members.length;
      c.members.forEach(function (b, i) {
        var offset = (i - (n - 1) / 2) * FAN_SPACING;
        var mx = c._x + offset, my = descendantY;

        svg.appendChild(el("line", { x1: c._x, y1: ancestorY, x2: mx, y2: my, class: "branch" }));

        var g = el("g", { "data-key": b.key });
        var markerClass = "marker ancestor-mode" + (b.favorite ? " favorite" : "");
        var marker = b.favorite
          ? el("polygon", { points: starPoints(mx, my, RADIUS * 1.35, RADIUS * 1.35 * 0.45), class: markerClass })
          : el("circle", { cx: mx, cy: my, r: RADIUS, class: markerClass });
        g.appendChild(marker);

        var label = el("text", {
          x: mx, y: my + RADIUS + 16, class: "marker-label", "text-anchor": "middle"
        });
        label.textContent = b.name.length > 20 ? b.name.slice(0, 18) + "…" : b.name;
        g.appendChild(label);

        g.addEventListener("mouseenter", function (ev) { showTooltip(b, ev); });
        g.addEventListener("mousemove", function (ev) { moveTooltip(ev); });
        g.addEventListener("mouseleave", hideTooltip);
        g.addEventListener("click", function () { openDetail(b); });

        svg.appendChild(g);
        markerNodes[b.key] = { g: g, circle: marker, label: label };
      });
    });

    applySearch();
  }

  // ---- tooltip ----
  var tooltip = document.getElementById("tooltip");
  function dateBasisSuffix(b) {
    return b.origin_estimate_basis === "cultural_proxy" ? " *" : "";
  }
  function showTooltip(b, ev) {
    tooltip.innerHTML =
      '<div class="name">' + escapeHtml(b.name) + '</div>' +
      '<div class="date">' + escapeHtml(b.estimate_value_raw) + dateBasisSuffix(b) +
        ' &middot; ' + fmtYbp(b.years_before_present) + '</div>' +
      (b.ancestor_lineage_name ? '<div class="note">Ancestor lineage: ' + escapeHtml(b.ancestor_lineage_name) + '</div>' : '') +
      '<div class="note">' + escapeHtml(truncate(b.estimate_note, 160)) + '</div>';
    tooltip.style.display = "block";
    moveTooltip(ev);
  }
  function showAncestorTooltip(c, ev) {
    tooltip.innerHTML =
      '<div class="name">' + escapeHtml(c.name) + '</div>' +
      '<div class="date">' + escapeHtml(c.estimate_value_raw) + ' &middot; ' + fmtYbp(c.years_before_present) + '</div>' +
      '<div class="note">Shared ancestor of ' + c.members.map(function (m) { return escapeHtml(m.name); }).join(", ") + '</div>';
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
      (b.also_known_as ? field("Also known as", escapeHtml(b.also_known_as)) : "") +
      (b.ancestor_lineage_name
        ? field("Ancestor lineage (MRCA)", escapeHtml(b.ancestor_lineage_name))
        : "") +
      field(b.ancestor_lineage_name ? "Ancestor date" : "Origin estimate",
        escapeHtml(b.estimate_value_raw) + dateBasisSuffix(b) + ' (' + escapeHtml(b.estimate_type) + ')') +
      (b.origin_estimate_basis === "cultural_proxy"
        ? field("", '<span style="color:var(--muted);font-size:12px">* This date reflects the culture/people associated with this breed, not direct evidence of the dog itself.</span>')
        : "") +
      (b.ancestor_lineage_name ? "" : field("Confidence", escapeHtml(b.confidence_tier))) +
      field(b.ancestor_lineage_name ? "Ancestor lineage note" : "Estimate note", escapeHtml(b.estimate_note)) +
      (b.recognition_year ? field("Recognition year", escapeHtml(b.recognition_year)) : "") +
      (b.notes ? field("Notes", escapeHtml(b.notes)) : "") +
      field("Primary source", '<a href="' + escapeAttr(b.primary_source_url) + '" target="_blank" rel="noopener">' +
            escapeHtml(b.primary_source_registry || b.primary_source_url) + '</a>');
    detail.classList.add("open");
  }
  function field(label, html) {
    return '<div class="field">' + (label ? '<div class="field-label">' + label + '</div>' : '') + '<div>' + html + '</div></div>';
  }
  function openAncestorDetail(c) {
    detailBody.innerHTML =
      '<h2>' + escapeHtml(c.name) + '</h2>' +
      '<div class="sub" style="color:var(--muted);font-size:12px">Most recent common ancestor (MRCA)</div>' +
      field("Estimated age", escapeHtml(c.estimate_value_raw) + ' (' + escapeHtml(c.estimate_type) + ')') +
      field("Note", escapeHtml(c.estimate_note)) +
      field("Shared by", c.members.map(function (m) { return escapeHtml(m.name); }).join(", ")) +
      (c.source_url
        ? field("Source", '<a href="' + escapeAttr(c.source_url) + '" target="_blank" rel="noopener">' +
              escapeHtml(c.source_citation || c.source_url) + '</a>')
        : "");
    detail.classList.add("open");
  }

  // ---- search ----
  var searchInput = document.getElementById("search");
  function applySearch() {
    var q = searchInput.value.trim().toLowerCase();
    currentBreeds.forEach(function (b) {
      var nodes = markerNodes[b.key];
      if (!nodes) return;
      var match = !q || b.name.toLowerCase().indexOf(q) !== -1 ||
        (b.also_known_as && b.also_known_as.toLowerCase().indexOf(q) !== -1);
      nodes.circle.classList.toggle("dim", !match);
      nodes.label.classList.toggle("dim", !match);
      nodes.circle.classList.toggle("hot", !!q && match);
    });
  }
  searchInput.addEventListener("input", applySearch);

  // ---- secondary chip list (undated, or "no ancestor data yet") ----
  var secondarySub = document.getElementById("undated-sub");
  var secondaryList = document.getElementById("undated-list");
  function renderSecondaryList() {
    secondaryList.innerHTML = "";
    var items, subText;
    if (mode === "ancestor") {
      items = noAncestorBreeds;
      subText = items.length + " breed" + (items.length === 1 ? "" : "s") +
        " have no ancestor-lineage (MRCA) data yet — a new, still mostly unpopulated view. Not shown above.";
    } else {
      items = undated;
      subText = items.length + " researched breed" + (items.length === 1 ? "" : "s") +
        " have no date estimate yet (origin_estimate_type: none) — not shown on the timeline above.";
    }
    secondarySub.textContent = subText;
    items.forEach(function (u) {
      var chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = u.name;
      secondaryList.appendChild(chip);
    });
  }

  // ---- header ----
  function renderHeader() {
    var totalResearched = DATA.total_researched || (breeds.length + undated.length);
    var popularityFilter = DATA.popularity_filter;
    var favoritesIncluded = DATA.favorites_included_beyond_filter || 0;
    var favoritesNote = favoritesIncluded
      ? " plus " + favoritesIncluded + " favorite" + (favoritesIncluded === 1 ? "" : "s")
      : "";
    var text;
    if (mode === "ancestor") {
      text = ancestorBreeds.length + " breed" + (ancestorBreeds.length === 1 ? "" : "s") +
        " plotted by oldest known common ancestor (MRCA), " + noAncestorBreeds.length +
        " with no ancestor-lineage data yet.";
    } else {
      text = popularityFilter
        ? breeds.length + " of the top " + popularityFilter + " most popular breeds" + favoritesNote +
          " plotted, " + undated.length + " undated (" + totalResearched +
          " researched overall, of ~628 in the full breed dataset)."
        : breeds.length + " breeds plotted, " + undated.length + " undated " +
          "(" + totalResearched + " of ~628 in the full breed dataset researched so far).";
    }
    document.getElementById("header-sub").textContent = text;
  }

  // ---- legend ----
  function renderLegend() {
    var founding = document.querySelectorAll(".legend-founding");
    var ancestor = document.querySelectorAll(".legend-ancestor");
    founding.forEach(function (el) { el.style.display = mode === "ancestor" ? "none" : ""; });
    ancestor.forEach(function (el) { el.style.display = mode === "ancestor" ? "" : "none"; });
  }

  // ---- scale note ----
  function renderScaleNote() {
    document.getElementById("scale-note").textContent = mode === "ancestor"
      ? "Log scale — recent centuries are stretched, deep history is compressed"
      : "Log scale, bisected: rich-confidence breeds plot above the line, anchor/vague below";
  }

  // ---- mode toggle ----
  var modeButtons = document.querySelectorAll("[data-mode]");
  modeButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var newMode = btn.getAttribute("data-mode");
      if (newMode === mode) return;
      mode = newMode;
      modeButtons.forEach(function (b) { b.classList.toggle("active", b === btn); });
      if (mode === "ancestor") { renderAncestorClusters(ancestorBreeds); } else { renderView(breeds); }
      renderSecondaryList();
      renderHeader();
      renderLegend();
      renderScaleNote();
    });
  });

  // ---- utils ----
  function truncate(s, n) { s = s || ""; return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // ---- initial render ----
  renderView(breeds);
  renderSecondaryList();
  renderHeader();
  renderLegend();
  renderScaleNote();
})();
