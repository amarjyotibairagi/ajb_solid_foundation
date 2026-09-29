import './style.css'

const env = import.meta.env
document.getElementById('year').textContent = String(new Date().getFullYear())

const domain = window.location.hostname.replace(/^www\./, '')
document.getElementById('tenant-example').textContent = `yourcompany.${domain}`

if (env.VITE_CONTACT_EMAIL) {
  const contact = document.getElementById('contact')
  contact.href = `mailto:${env.VITE_CONTACT_EMAIL}`
  contact.hidden = false
}
