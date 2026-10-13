import "./eyes.js"
import "./flow.js"

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const text = document.getElementById(button.dataset.copy)?.textContent ?? ""
    try {
      await navigator.clipboard.writeText(text)
      button.classList.add("copied")
      setTimeout(() => button.classList.remove("copied"), 1600)
    } catch {}
  })
}
