FROM node:20-slim

WORKDIR /app

# Install frontend dependencies and build
COPY frontend/package*.json frontend/
RUN cd frontend && npm install

COPY frontend/ frontend/
RUN cd frontend && npm run build

# Install backend dependencies and build
COPY backend/package*.json backend/
RUN cd backend && npm install

COPY backend/ backend/
RUN cd backend && npm run build

# Copy built frontend into backend/public
RUN cp -r frontend/dist backend/public

WORKDIR /app/backend

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "dist/index.js"]
