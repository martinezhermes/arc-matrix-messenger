# ARC Matrix Messenger - Installation and Setup Guide

## Prerequisites

Before running ARC Matrix Messenger, ensure you have the following:

1. **Go 1.21+** installed on your system
2. **RabbitMQ** server running at `192.168.0.197:5672` (as configured in `.env`)
3. **MongoDB** server running at `192.168.0.197:27017` (as configured in `.env`)
4. **Matrix account** credentials for the user specified in `.env` (ACH9)

## Installation

1. Navigate to the project directory:
```bash
cd /home/ach9/Developer/riddlesandillusions/arc-matrix-messenger
```

2. Verify the go.mod file exists:
```bash
ls -la go.mod
```

3. Install dependencies:
```bash
go mod download
```

## Configuration

The `.env` file is already configured with the required settings. Verify that:
- RabbitMQ connection details match your server
- MongoDB connection string is correct
- `APP_USER`, `APP_ID`, and `WID` reflect your Matrix account

## Running the Application

### 1. Regular Mode (Normal Operation)

This mode runs the application to listen for Matrix events and process commands:

```bash
# Load environment variables
source .env

# Build and run the application
go build -o arc-messenger ./cmd/main.go
./arc-messenger
```

On first run, you'll need to authenticate with Matrix. The application will prompt for your credentials.

### 2. Bootstrap Mode (Historical Message Fetching)

This mode fetches historical messages from all rooms:

```bash
# Load environment variables
source .env

# Build and run in bootstrap mode
go build -o arc-messenger ./cmd/main.go
./arc-messenger --bootstrap
```

You can customize bootstrap behavior with additional flags:
```bash
./arc-messenger --bootstrap --batch-size=100 --max-retries=3
```

### 3. Debug Mode (Targeted Message Inspection)

This mode fetches messages from a specific room for debugging:

```bash
# Load environment variables
source .env

# Fetch messages from a specific room
./arc-messenger --debug --room "!room:matrix.org" --limit=50
```

Replace `!room:matrix.org` with your target room ID.

## First-Time Authentication

On the first run, the application will prompt for your Matrix credentials:

```
Matrix username: @ach9:matrix.org
Matrix password: ********
```

After successful authentication, the session will be saved to MongoDB, and subsequent runs won't require login.

## Verifying Operation

Once running, check for these log messages to confirm proper operation:

```
INFO Connected to MongoDB
INFO RabbitMQ publisher initialized successfully
INFO RabbitMQ subscriber initialized successfully
INFO Loaded existing session
INFO Starting Matrix sync
INFO Event handlers registered
INFO Egress consumer started
INFO Matrix application is ready
```

## Stopping the Application

Press `Ctrl+C` to gracefully shut down the application. The application will:
1. Stop Matrix sync
2. Close RabbitMQ connections
3. Close MongoDB connection
4. Exit cleanly

## Troubleshooting

### Common Build Errors
If you see errors like:
```
go: go.mod file not found in current directory or any parent directory
```
Make sure you're in the correct directory:
```bash
cd /home/ach9/Developer/riddlesandillusions/arc-matrix-messenger
```

### Go Module Download Issues
If `go mod download` appears to hang with no output:

1. **This is normal behavior** for the first run as Go downloads all dependencies
2. **Typical duration**: 1-5 minutes depending on network speed
3. **Check progress** by opening another terminal and running:
   ```bash
   ls -la $(go env GOPATH)/pkg/mod/cache/download
   ```
   You should see files being downloaded

4. **Enable verbose output** to see progress:
   ```bash
   GOPROXY=direct GOSUMDB=off go mod download -x
   ```

5. **If truly stuck** (more than 10 minutes):
   - Check network connectivity
   - Verify GitHub access (many Go modules are hosted there)
   - Try setting a proxy if needed:
     ```bash
     export GOPROXY=https://proxy.golang.org,direct
     ```

### Connection Issues
- Verify RabbitMQ and MongoDB servers are running
- Check firewall settings allow connections to ports 5672 (RabbitMQ) and 27017 (MongoDB)
- Confirm credentials in `.env` are correct

### Authentication Problems
- Ensure you're using the full Matrix ID format (`@user:server`)
- Verify password is correct
- Check if your Matrix server requires additional authentication steps

### Message Processing Issues
- Check RabbitMQ exchanges and queues exist
- Verify MongoDB collections were created
