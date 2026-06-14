#!/usr/bin/env ruby
# frozen_string_literal: true

# A tiny request-counting web server using only the Ruby standard library.
#
# Routes:
#   GET /count  -> returns the current count, then increments it internally,
#                  so each subsequent call is one higher.
#   GET /reset  -> resets the count back to 0.
#
# Usage:
#   ruby count_server.rb [port]   (defaults to port 4567)

require "socket"

PORT = (ARGV[0] || ENV["PORT"] || 4567).to_i

count = 0
mutex = Mutex.new # guard the counter so concurrent requests stay consistent

server = TCPServer.new("0.0.0.0", PORT)
puts "Count server listening on http://localhost:#{PORT}"
puts "  GET /count  -> current count (then +1)"
puts "  GET /reset  -> reset count to 0"

def respond(client, status, body)
  client.print "HTTP/1.1 #{status}\r\n"
  client.print "Content-Type: text/plain\r\n"
  client.print "Content-Length: #{body.bytesize}\r\n"
  client.print "Connection: close\r\n"
  client.print "\r\n"
  client.print body
end

loop do
  client = server.accept
  begin
    request_line = client.gets
    next if request_line.nil?

    method, path, = request_line.split(" ")
    # Strip any query string so "/count?foo=bar" still matches.
    route = path.to_s.split("?").first

    case [method, route]
    when ["GET", "/count"]
      current = mutex.synchronize do
        value = count
        count += 1
        value
      end
      respond(client, "200 OK", "#{current}\n")
    when ["GET", "/reset"]
      mutex.synchronize { count = 0 }
      respond(client, "200 OK", "Count reset to 0\n")
    else
      respond(client, "404 Not Found", "Not found\n")
    end
  rescue StandardError => e
    warn "Error handling request: #{e.message}"
  ensure
    client.close
  end
end
