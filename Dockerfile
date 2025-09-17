# Use an official lightweight Node.js image
FROM node:18-alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json for dependency installation
# This is done first to leverage Docker's layer caching
COPY package*.json ./

# Install production dependencies using npm ci for faster, deterministic builds
RUN npm ci --only=production

# Copy the rest of your application's source code
COPY . .

# The command that will be run when the container starts
CMD ["npm", "run", "start"]