// Custom cake gallery: tap a photo to see it full size.
const box = document.getElementById("lightbox");
const big = box.querySelector("img");

document.querySelectorAll(".gallery-grid button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const img = btn.querySelector("img");
    big.src = img.src;
    big.alt = img.alt;
    box.showModal();
  });
});

box.querySelector(".lightbox-close").addEventListener("click", () => box.close());
// Clicking the dark backdrop (outside the photo) closes it too
box.addEventListener("click", (e) => { if (e.target === box) box.close(); });
