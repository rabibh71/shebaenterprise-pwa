function openPage(page) {
  window.location.href = page;
}

let addMenuOpen = false;

function toggleAddMenu() {
  const menu = document.getElementById("addMenu");
  if (!menu) return;

  addMenuOpen = !addMenuOpen;
  menu.classList.toggle("show", addMenuOpen);
}

document.addEventListener("click", function (e) {
  const menu = document.getElementById("addMenu");
  const centerBtn = document.querySelector(".centerBtn");

  if (!menu || !centerBtn) return;

  if (!menu.contains(e.target) && !centerBtn.contains(e.target)) {
    menu.classList.remove("show");
    addMenuOpen = false;
  }
});

window.openPage = openPage;
window.toggleAddMenu = toggleAddMenu;