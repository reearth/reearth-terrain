// Attribution display for the Navara renderer.
// Mirrors the approach from navara-template/src/attribution.ts,
// adapted for viewer.html's HTML attribution strings.
function buildNavaraAttribution(attributionHtmlList) {
  const el = document.createElement("div");
  Object.assign(el.style, {
    position: "absolute",
    bottom: "0",
    right: "0",
    display: "flex",
    flexDirection: "row",
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    color: "#fff",
    fontFamily: "Arial, Helvetica, sans-serif",
    fontSize: "12px",
    lineHeight: "1",
    letterSpacing: "0.02em",
    zIndex: "5",
    padding: "2px 4px",
  });

  attributionHtmlList.forEach((html, i) => {
    const span = document.createElement("span");
    span.innerHTML = html;
    Object.assign(span.style, {
      padding: "4px 8px",
      borderLeft: i === 0 ? "none" : "1px solid rgba(255, 255, 255, 0.4)",
      whiteSpace: "nowrap",
    });
    span.querySelectorAll("a").forEach((a) => {
      Object.assign(a.style, {
        color: "#fff",
        textDecoration: "none",
      });
      a.addEventListener("mouseenter", () => { a.style.textDecoration = "underline"; });
      a.addEventListener("mouseleave", () => { a.style.textDecoration = "none"; });
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    });
    el.appendChild(span);
  });

  return el;
}
