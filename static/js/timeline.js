(function () {
  var DATA = window.__TIMELINE_DATA__ || { breeds: [], undated: [] };
  var breeds = DATA.breeds || [];
  var undated = DATA.undated || [];
  var villageDogs = DATA.village_dogs || [];
  var villageDogsUndated = DATA.village_dogs_undated || [];

  var svgNS = "http://www.w3.org/2000/svg";
  var svg = document.getElementById("chart");

  // ---- layout constants (logical SVG units; viewBox scales this to fit) ----
  var MARGIN_L = 60, MARGIN_R = 60, MARGIN_TOP = 40;
  var PX_PER_TICK_GROUP = 340;   // controls overall logical width
  var LANE_HEIGHT = 28;
  var STEM_BASE = 24;
  var RADIUS = 9;
  var MIN_GAP = 112; // wide enough for a typical breed-name label, not just the circle

  var DOMAIN_MAX = 20000;  // years ago -- oldest current data point is ~14,600 ya (precontact American dog); 50k left a lot of empty space
  var DOMAIN_MIN = 10;

  var TICKS = [20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10];

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
        source_url: b.mrca.source_url,
        related_breeds: b.mrca.related_breeds
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
          related_breeds: b.related_breeds || [],
          members: []
        };
        order.push(id);
      }
      map[id].members.push(b);
    });
    return order.map(function (id) {
      var c = map[id];
      var memberKeys = {};
      c.members.forEach(function (m) { memberKeys[m.key] = true; });
      c.unplottedRelated = c.related_breeds.filter(function (b) { return !memberKeys[b.key]; });
      return c;
    });
  }

  var ancestorBreeds = buildAncestorDataset();
  var noAncestorBreeds = breeds.concat(undated).filter(function (b) { return !b.mrca; });
  var FAN_RISE = 55;     // vertical distance from the descendant row up to the ancestor node
  var FAN_SPACING = 90;  // horizontal spacing between fanned-out descendant markers

  // Ancestor-view vertical metrics. A "lane" here holds a whole cluster (ancestor
  // label + diamond + FAN_RISE + descendant row + descendant labels), not a single
  // marker the way LANE_HEIGHT assumes in the founding view -- stepping lanes by
  // LANE_HEIGHT stacked clusters 28px apart when each is ~130px tall, which is what
  // made them overlap regardless of how well they were packed horizontally.
  var ANC_STEM_BASE = 40; // axis -> descendant row; wide enough for a descendant label to sit between them
  var ANC_HEAD = 34;      // ancestor node -> past its own label
  var ANC_LANE_STEP = ANC_STEM_BASE + FAN_RISE + ANC_HEAD; // full vertical span of one cluster
  var ANC_LABEL_CHAR_W = 6.0; // approx px/char for .ancestor-label (10.5px, 600 weight)

  // ---- mode state ----
  var mode = "founding"; // "founding" | "ancestor" | "village"
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
        if (isFallbackDate(b)) {
          g.appendChild(el("circle", { cx: b._x, cy: y, r: RADIUS * 1.7, class: "fallback-ring" }));
        }

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

    // A cluster must reserve room for whichever is wider: its fanned descendant row,
    // or its own lineage label (e.g. "Kamikuroiwa Rock Shelter Jomon dog (M1
    // haplotype)" is far wider than its three-marker fan).
    function halfWidthOf(c) {
      var fanCount = c.members.length + c.unplottedRelated.length;
      var fanHalf = (fanCount - 1) * FAN_SPACING / 2 + MIN_GAP / 2;
      var labelHalf = c.name.length * ANC_LABEL_CHAR_W / 2 + 10;
      return Math.max(fanHalf, labelHalf);
    }

    // Bisected layout, same idea as the founding view: the axis runs through the
    // middle and lineages alternate above/below in date order, so two lineages that
    // sit close together on the x-axis are never in the same vertical band.
    sorted.forEach(function (c, i) { c._side = i % 2 === 0 ? -1 : 1; });

    // Then lane-pack each side independently -- only needed when two lineages on the
    // SAME side still overlap horizontally, which alternation makes rare.
    function packSide(side) {
      var laneRightEdge = [];
      sorted.forEach(function (c) {
        if (c._side !== side) return;
        var halfWidth = halfWidthOf(c);
        var lane = 0;
        while (laneRightEdge[lane] !== undefined && (c._x - halfWidth) < laneRightEdge[lane]) lane++;
        laneRightEdge[lane] = c._x + halfWidth;
        c._lane = lane;
      });
      return laneRightEdge.length - 1; // -1 when this side is empty
    }
    var aboveMaxLane = packSide(-1);
    var belowMaxLane = packSide(1);

    var TICK_MARGIN = 24; // reserved space for tick date labels, top and bottom
    var axisY = TICK_MARGIN + (aboveMaxLane + 1) * ANC_LANE_STEP;
    var gridBottomY = axisY + (belowMaxLane + 1) * ANC_LANE_STEP;
    var logicalHeight = gridBottomY + TICK_MARGIN + 20;

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

    sorted.forEach(function (c) {
      // s = -1 above the axis, +1 below; every offset below is mirrored through it.
      var s = c._side;
      var descendantY = axisY + s * (ANC_STEM_BASE + c._lane * ANC_LANE_STEP);
      var ancestorY = descendantY + s * FAN_RISE;

      // trunk: the one line actually anchored to the real date on the axis
      svg.appendChild(el("line", { x1: c._x, y1: axisY, x2: c._x, y2: ancestorY, class: "stem trunk" }));

      // ancestor (MRCA) node
      var ancestorG = el("g", { "data-lineage": c.lineage_id });
      var ancestorMarker = el("polygon", {
        points: diamondPoints(c._x, ancestorY, RADIUS * 1.7),
        class: "marker ancestor-node"
      });
      ancestorG.appendChild(ancestorMarker);
      // lineage label sits on the far side of the diamond, away from the axis
      var ancestorLabel = el("text", {
        x: c._x,
        y: s < 0 ? ancestorY - RADIUS * 1.7 - 6 : ancestorY + RADIUS * 1.7 + 16,
        class: "marker-label ancestor-label", "text-anchor": "middle"
      });
      ancestorLabel.textContent = c.name;
      ancestorG.appendChild(ancestorLabel);
      ancestorG.addEventListener("mouseenter", function (ev) { showAncestorTooltip(c, ev); });
      ancestorG.addEventListener("mousemove", function (ev) { moveTooltip(ev); });
      ancestorG.addEventListener("mouseleave", hideTooltip);
      ancestorG.addEventListener("click", function () { openAncestorDetail(c); });
      svg.appendChild(ancestorG);

      // descendants, fanned out below the ancestor, each linked to it by a branch line
      var n = c.members.length + c.unplottedRelated.length;
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
          x: mx, y: s < 0 ? my + RADIUS + 16 : my - RADIUS - 6,
          class: "marker-label", "text-anchor": "middle"
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

      // related breeds named in the lineage's research but not yet in the dataset
      // (no landrace row, no mrca_lineage_id of their own) -- drawn hollow/dashed
      // and non-interactive so they read as "known but unresearched," not as a
      // fully-dated breed sharing the same visual weight as real members.
      c.unplottedRelated.forEach(function (b, j) {
        var i = c.members.length + j;
        var offset = (i - (n - 1) / 2) * FAN_SPACING;
        var mx = c._x + offset, my = descendantY;

        svg.appendChild(el("line", { x1: c._x, y1: ancestorY, x2: mx, y2: my, class: "branch unplotted" }));

        var g = el("g", { "data-key": b.key });
        var marker = el("circle", { cx: mx, cy: my, r: RADIUS, class: "marker ancestor-unplotted" });
        g.appendChild(marker);

        var label = el("text", {
          x: mx, y: s < 0 ? my + RADIUS + 16 : my - RADIUS - 6,
          class: "marker-label unplotted-label", "text-anchor": "middle"
        });
        label.textContent = b.name.length > 20 ? b.name.slice(0, 18) + "…" : b.name;
        g.appendChild(label);

        g.addEventListener("mouseenter", function (ev) { showUnplottedTooltip(b, c, ev); });
        g.addEventListener("mousemove", function (ev) { moveTooltip(ev); });
        g.addEventListener("mouseleave", hideTooltip);

        svg.appendChild(g);
      });
    });

    applySearch();
  }

  // ---- village dog view: one bar per population, from divergence date to today,
  // since the population (unlike an MRCA specimen) hasn't stopped existing ----
  var villageNodes = {};
  var VILLAGE_FAN_DROP = 55; // vertical distance from the bar down to fanned related-breed markers

  function renderVillageView(populations) {
    markerNodes = {};
    villageNodes = {};
    currentBreeds = [];
    populations.forEach(function (p) { currentBreeds = currentBreeds.concat(p.related_breeds); });
    svg.innerHTML = "";

    var todayX = xOf(10);
    populations.forEach(function (p, i) { p._x = xOf(p.years_before_present); p._lane = i; });

    var maxLane = populations.length - 1;
    var axisY = MARGIN_TOP + (maxLane + 1) * LANE_HEIGHT + STEM_BASE + VILLAGE_FAN_DROP;
    var logicalHeight = axisY + 40;

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

    populations.forEach(function (p) {
      var barY = axisY - STEM_BASE - p._lane * LANE_HEIGHT - VILLAGE_FAN_DROP;

      // trunk: anchors the bar's divergence-date end to the real date on the axis
      svg.appendChild(el("line", { x1: p._x, y1: axisY, x2: p._x, y2: barY, class: "stem trunk" }));

      var g = el("g", { "data-population": p.population_id });
      g.appendChild(el("line", { x1: p._x, y1: barY, x2: todayX, y2: barY, class: "village-bar" }));
      g.appendChild(el("circle", { cx: p._x, cy: barY, r: RADIUS * 0.6, class: "marker village-node" }));
      g.appendChild(el("circle", { cx: todayX, cy: barY, r: RADIUS * 0.55, class: "village-bar-end" }));

      var label = el("text", { x: p._x, y: barY - 10, class: "marker-label village-label", "text-anchor": "start" });
      label.textContent = p.name;
      g.appendChild(label);

      g.addEventListener("mouseenter", function (ev) { showVillageTooltip(p, ev); });
      g.addEventListener("mousemove", function (ev) { moveTooltip(ev); });
      g.addEventListener("mouseleave", hideTooltip);
      g.addEventListener("click", function () { openVillageDetail(p); });
      svg.appendChild(g);
      villageNodes[p.population_id] = { g: g, label: label };

      // related breeds, fanned below the bar's divergence-date end
      var n = p.related_breeds.length;
      p.related_breeds.forEach(function (b, i) {
        var offset = (i - (n - 1) / 2) * FAN_SPACING;
        var mx = p._x + offset, my = barY + VILLAGE_FAN_DROP;

        svg.appendChild(el("line", { x1: p._x, y1: barY, x2: mx, y2: my, class: "village-branch" }));

        var bg = el("g", { "data-key": b.key });
        var marker = el("circle", { cx: mx, cy: my, r: RADIUS, class: "marker village-node" });
        bg.appendChild(marker);
        var bLabel = el("text", { x: mx, y: my + RADIUS + 16, class: "marker-label", "text-anchor": "middle" });
        bLabel.textContent = b.name.length > 20 ? b.name.slice(0, 18) + "…" : b.name;
        bg.appendChild(bLabel);

        bg.addEventListener("mouseenter", function (ev) { showVillageBreedTooltip(b, p, ev); });
        bg.addEventListener("mousemove", function (ev) { moveTooltip(ev); });
        bg.addEventListener("mouseleave", hideTooltip);
        bg.addEventListener("click", function () { openVillageDetail(p); });
        svg.appendChild(bg);
        markerNodes[b.key] = { g: bg, circle: marker, label: bLabel };
      });
    });

    applySearch();
  }

  // ---- tooltip ----
  var tooltip = document.getElementById("tooltip");
  function dateBasisSuffix(b) {
    return b.origin_estimate_basis === "cultural_proxy" ? " *" : "";
  }
  // A fallback date is borrowed from a deeper tier (MRCA ancestor or village-dog
  // population) because the breed has no landrace date of its own -- distinct from
  // cultural_proxy (a real tier-2 date, just about the people rather than the dog).
  function isFallbackDate(b) {
    return b.date_source === "mrca" || b.date_source === "village";
  }
  function fallbackSuffix(b) {
    return isFallbackDate(b) ? " †" : "";
  }
  function fallbackNote(b) {
    if (!isFallbackDate(b)) return "";
    var tierLabel = b.date_source === "mrca" ? "oldest common ancestor (MRCA)" : "village dog population";
    return '<div class="note">† Borrowed from this breed’s ' + tierLabel + ' (' +
      escapeHtml(b.fallback_source_name) + ') — no landrace date of its own exists.</div>';
  }
  function showTooltip(b, ev) {
    tooltip.innerHTML =
      '<div class="name">' + escapeHtml(b.name) + '</div>' +
      '<div class="date">' + escapeHtml(b.estimate_value_raw) + dateBasisSuffix(b) + fallbackSuffix(b) +
        ' &middot; ' + fmtYbp(b.years_before_present) + '</div>' +
      (b.ancestor_lineage_name ? '<div class="note">Ancestor lineage: ' + escapeHtml(b.ancestor_lineage_name) + '</div>' : '') +
      fallbackNote(b) +
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
  function showVillageTooltip(p, ev) {
    tooltip.innerHTML =
      '<div class="name">' + escapeHtml(p.name) + '</div>' +
      '<div class="date">' + escapeHtml(p.estimate_value_raw) + ' &middot; ' + fmtYbp(p.years_before_present) +
        ' &ndash; today</div>' +
      '<div class="note">' + escapeHtml(p.region) + '</div>' +
      '<div class="note">' + escapeHtml(truncate(p.estimate_note, 160)) + '</div>';
    tooltip.style.display = "block";
    moveTooltip(ev);
  }
  function showUnplottedTooltip(b, c, ev) {
    tooltip.innerHTML =
      '<div class="name">' + escapeHtml(b.name) + '</div>' +
      '<div class="note">Named in ' + escapeHtml(c.name) + '’s research as related, but not yet in this dataset — no date of its own to plot.</div>';
    tooltip.style.display = "block";
    moveTooltip(ev);
  }
  function showVillageBreedTooltip(b, p, ev) {
    tooltip.innerHTML =
      '<div class="name">' + escapeHtml(b.name) + '</div>' +
      '<div class="note">Research drew on ' + escapeHtml(p.name) + '</div>';
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
        escapeHtml(b.estimate_value_raw) + dateBasisSuffix(b) + fallbackSuffix(b) + ' (' + escapeHtml(b.estimate_type) + ')') +
      (b.origin_estimate_basis === "cultural_proxy"
        ? field("", '<span style="color:var(--muted);font-size:12px">* This date reflects the culture/people associated with this breed, not direct evidence of the dog itself.</span>')
        : "") +
      (isFallbackDate(b)
        ? field("", '<span style="color:var(--muted);font-size:12px">† This breed has no landrace date of its own — this is borrowed from its ' +
            (b.date_source === "mrca" ? "oldest common ancestor (MRCA)" : "village dog population") +
            ', ' + escapeHtml(b.fallback_source_name) + '.</span>')
        : "") +
      (isFallbackDate(b) && b.breed_note
        ? field("About this breed (primary source)", escapeHtml(b.breed_note))
        : "") +
      (b.ancestor_lineage_name ? "" : field("Confidence", escapeHtml(b.confidence_tier))) +
      field(
        b.ancestor_lineage_name ? "Ancestor lineage note"
          : b.date_source === "mrca" ? "Ancestor lineage note"
          : b.date_source === "village" ? "Village population note"
          : "Estimate note",
        formatNote(b.estimate_note)) +
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
    var unplottedRelated = c.unplottedRelated || [];
    detailBody.innerHTML =
      '<h2>' + escapeHtml(c.name) + '</h2>' +
      '<div class="sub" style="color:var(--muted);font-size:12px">Most recent common ancestor (MRCA)</div>' +
      field("Estimated age", escapeHtml(c.estimate_value_raw) + ' (' + escapeHtml(c.estimate_type) + ')') +
      field("Note", formatNote(c.estimate_note)) +
      field("Shared by", c.members.map(function (m) { return escapeHtml(m.name); }).join(", ")) +
      (unplottedRelated.length
        ? field("Also connected in research (not otherwise plotted)",
            unplottedRelated.map(function (b) { return escapeHtml(b.name); }).join(", "))
        : "") +
      (c.source_url
        ? field("Source", '<a href="' + escapeAttr(c.source_url) + '" target="_blank" rel="noopener">' +
              escapeHtml(c.source_citation || c.source_url) + '</a>')
        : "");
    detail.classList.add("open");
  }

  function openVillageDetail(p) {
    detailBody.innerHTML =
      '<h2>' + escapeHtml(p.name) + '</h2>' +
      '<div class="sub" style="color:var(--muted);font-size:12px">Village dog population &mdash; extant, unmanaged, not bred</div>' +
      field("Region", escapeHtml(p.region)) +
      field("Diverged from", escapeHtml(p.diverged_from)) +
      field("Divergence date", escapeHtml(p.estimate_value_raw) + ' (' + escapeHtml(p.estimate_type) + ')') +
      field("", '<span style="color:var(--muted);font-size:12px">Still around today, unmanaged &mdash; the bar runs from the divergence date to now, not to a founding event.</span>') +
      field("Note", formatNote(p.estimate_note)) +
      (p.related_breeds.length
        ? field("Breeds whose research drew on this population",
            p.related_breeds.map(function (b) { return escapeHtml(b.name); }).join(", "))
        : "") +
      (p.notes ? field("Notes", escapeHtml(p.notes)) : "") +
      (p.source_url
        ? field("Source", '<a href="' + escapeAttr(p.source_url) + '" target="_blank" rel="noopener">' +
              escapeHtml(p.source_citation || p.source_url) + '</a>')
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
    } else if (mode === "village") {
      items = villageDogsUndated;
      subText = items.length + " village dog population" + (items.length === 1 ? "" : "s") +
        " tracked but not plottable — genetically real, but no dated divergence estimate found yet " +
        "(see village_dog_populations.csv). Not shown on the bars above; will get a bar automatically " +
        "if a dated source is added.";
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
    var lineageIncluded = DATA.lineage_included_beyond_filter || 0;
    var favoritesNote = favoritesIncluded
      ? " plus " + favoritesIncluded + " favorite" + (favoritesIncluded === 1 ? "" : "s")
      : "";
    favoritesNote += lineageIncluded
      ? " plus " + lineageIncluded + " more for shared-ancestor context"
      : "";
    var text;
    if (mode === "ancestor") {
      text = ancestorBreeds.length + " breed" + (ancestorBreeds.length === 1 ? "" : "s") +
        " plotted by oldest known common ancestor (MRCA), " + noAncestorBreeds.length +
        " with no ancestor-lineage data yet.";
    } else if (mode === "village") {
      text = villageDogs.length + " village dog population" + (villageDogs.length === 1 ? "" : "s") +
        " plotted — extant, unmanaged, human-commensal populations that never became a breed.";
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
    var village = document.querySelectorAll(".legend-village");
    founding.forEach(function (el) { el.style.display = mode === "founding" ? "" : "none"; });
    ancestor.forEach(function (el) { el.style.display = mode === "ancestor" ? "" : "none"; });
    village.forEach(function (el) { el.style.display = mode === "village" ? "" : "none"; });
  }

  // ---- scale note ----
  function renderScaleNote() {
    var text = "Log scale, bisected: rich-confidence breeds plot above the line, anchor/vague below";
    if (mode === "ancestor") text = "Log scale — recent centuries are stretched, deep history is compressed";
    if (mode === "village") text = "Log scale — bars run from the divergence date to today, since the population is still around";
    document.getElementById("scale-note").textContent = text;
  }

  // ---- mode toggle ----
  var modeButtons = document.querySelectorAll("[data-mode]");
  modeButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var newMode = btn.getAttribute("data-mode");
      if (newMode === mode) return;
      mode = newMode;
      modeButtons.forEach(function (b) { b.classList.toggle("active", b === btn); });
      if (mode === "ancestor") { renderAncestorClusters(ancestorBreeds); }
      else if (mode === "village") { renderVillageView(villageDogs); }
      else { renderView(breeds); }
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
  // Research notes sometimes splice in a labeled secondary-source aside
  // mid-paragraph (e.g. "...in the 1930s." SECONDARY GENETIC SOURCE: Zhang...,
  // or "...standard. SECONDARY: Thomas Simpson Hall..."). Break it onto its own
  // paragraph rather than running on -- but only when it's not already the
  // first word (nothing to break from there, e.g. Saluki/Chow Chow's notes).
  function formatNote(s) {
    return escapeHtml(s).replace(/\bSECONDARY\b/g, function (match, offset) {
      return offset === 0 ? match : "<br><br>" + match;
    });
  }

  // ---- initial render ----
  renderView(breeds);
  renderSecondaryList();
  renderHeader();
  renderLegend();
  renderScaleNote();
})();
