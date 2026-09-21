FROM nginx:alpine

# Copia configuração e ficheiros
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html

# Railway usa a variável PORT (normalmente 8080)
EXPOSE 8080

# Script de arranque que substitui a porta dinamicamente
CMD sh -c "sed -i 's/listen 80/listen ${PORT:-8080}/g' /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"