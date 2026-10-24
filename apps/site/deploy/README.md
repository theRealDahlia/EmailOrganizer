# Hosting on AWS Lightsail

One-time setup for www.sweepmail.org on a Lightsail Linux instance (Ubuntu).

1. **Static IP:** in Lightsail, create a static IP and attach it to the instance, so the address survives restarts.
2. **Firewall:** in the instance's Networking tab, allow HTTP (80) and HTTPS (443) alongside SSH.
3. **DNS:** at your DNS provider, add an `A` record for `www` pointing to the static IP, and an `A` record for the bare domain `sweepmail.org` pointing to the same IP (it redirects to `www`).
4. **Server:**
   ```bash
   sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx rsync
   sudo mkdir -p /var/www/sweepmail && sudo chown $USER /var/www/sweepmail
   sudo cp nginx.conf /etc/nginx/conf.d/sweepmail.conf   # copy from this folder
   sudo nginx -t && sudo systemctl reload nginx
   ```
5. **Deploy** (from your Mac, repo root):
   ```bash
   SWEEP_SSH=ubuntu@<static-ip> SWEEP_KEY=~/.ssh/<lightsail-key>.pem npm run deploy -w @organizer/site
   ```
6. **HTTPS**, once DNS has propagated:
   ```bash
   sudo certbot --nginx -d www.sweepmail.org -d sweepmail.org
   ```
   Certbot renews the certificate automatically.
