# Unit test for the ingest WebAPI Ruby normalization (the exact snippet deployed into the tree).
# Mimics the engine: @results raises IndexError on a missing key (intolerant default_proc).
require 'json'; require 'time'
NORM = File.read(ARGV[0])
def results(h) ; x = Hash.new { |hash, k| raise IndexError, "Unable to retrieve hash value for the key #{k.inspect}" } ; h.each { |k, v| x[k] = v } ; x ; end
def run(body, res = {}, caller = 'john') ; @requested_by = caller && { 'username' => caller } ; @request = { 'Body' => body.is_a?(String) ? body : body.to_json } ; @results = results(res) ; eval(NORM) ; end
$fail = 0
def check(name, cond) ; puts "#{cond ? 'PASS' : 'FAIL'}  #{name}" ; $fail += 1 unless cond ; end
now = Time.now.utc
base = { 'schemaVersion' => '1.0', 'tenantId' => 'borealis', 'source' => 'optical-ems', 'sourceEventId' => 'EMS-1', 'eventTime' => (now - 30).iso8601,
         'resourceRef' => 'ROADM-STP-02:OTS-1', 'condition' => 'LOS', 'vendorSeverity' => 'CR', 'state' => 'raise' }
maps = { 'submissions' => [
  { 'values' => { 'External ID' => 'ROADM-STP-02:OTS-1', 'Source System' => 'optical-ems', 'Internal ID' => 'ROADM-STP-02/OTS-1', 'Match Kind' => 'Alias', 'Valid To' => '' } },
  { 'values' => { 'External ID' => 'ROADM-STP-02', 'Source System' => 'optical-ems', 'Internal ID' => 'ROADM-STP-02', 'Match Kind' => 'Parent', 'Valid To' => '' } },
  { 'values' => { 'External ID' => 'gNB-STP-C05', 'Source System' => 'ran-oss', 'Internal ID' => 'GNB-STP-C05', 'Match Kind' => 'Alias', 'Valid To' => '' } } ] }.to_json
empty = { 'submissions' => [] }.to_json
r0 = { 'Find Duplicate' => { 'Response Body' => empty }, 'Resolve Resource' => { 'Response Body' => maps }, 'Find Active Alarm' => { 'Response Body' => empty } }

n = run(base, r0)
check 'new raise', n['kind'] == 'new'
check 'severity CR→Critical', n['sev'] == 'Critical'
check 'resource resolved via alias', n['rid'] == 'ROADM-STP-02/OTS-1' && n['match'] == 'Alias'
check 'fingerprint uses internal id', n['fp'] == 'borealis|ROADM-STP-02/OTS-1|LOS'
check 'deterministic alarm id', n['aid'] == run(base, r0)['aid'] && n['aid'].start_with?('ALM-')
check 'idempotency key', n['idem'] == 'borealis|optical-ems|EMS-1'
check 'service affecting from catalog', n['ci']['sa'] == true && n['ci']['x'] == 'lossOfSignal'
check 'not late (30s)', n['late'] == false

n = run(base.merge('resourceRef' => 'ROADM-STP-02:OSC-9'), r0)
check 'parent fallback', n['rid'] == 'ROADM-STP-02' && n['match'] == 'Alias' && n['notes'].any? { |x| x.include?('parent') }
n = run(base.merge('resourceRef' => 'XYZ-99:P1'), r0)
check 'unmatched keeps ref in fingerprint', n['rid'] == '' && n['match'] == 'Unmatched' && n['fp'] == 'borealis|ref:XYZ-99:P1|LOS'
n = run(base.merge('vendorSeverity' => 'P0-EMERGENCY'), r0)
check 'unknown severity → Indeterminate + note', n['sev'] == 'Indeterminate' && n['notes'].join.include?('unmapped severity')
n = run(base.merge('eventTime' => (now + 600).iso8601), r0)
check 'future skew clamped', n['skew'] == true && (Time.iso8601(n['et']) - now).abs < 5
n = run(base.merge('eventTime' => (now - 600).iso8601), r0)
check 'late flagged', n['late'] == true
n = run(base.reject { |k, _| k == 'eventTime' }, r0)
check 'missing eventTime → invalid', n['kind'] == 'invalid' && n['errs'].include?('missing eventTime')
n = run(base.merge('eventTime' => '2026-09-27 13:00'), r0)
check 'non-ISO time → invalid', n['kind'] == 'invalid'
n = run(base.merge('tenantId' => ''), r0)
check 'no tenant → unscoped', n['kind'] == 'unscoped'
n = run('not json', r0)
check 'garbage body → unscoped', n['kind'] == 'unscoped' && n['errs'].include?('body is not a JSON object')
check 'invalid idem uses body hash', n['idem'].start_with?('invalid|')
dup = r0.merge('Find Duplicate' => { 'Response Body' => { 'submissions' => [{ 'id' => 'x' }] }.to_json })
check 'duplicate detected', run(base, dup)['kind'] == 'duplicate'
act = { 'submissions' => [{ 'id' => '11111111-2222-3333-4444-555555555555', 'values' => { 'Alarm ID' => 'ALM-EXISTING', 'First Occurred At' => (now - 100).iso8601, 'Occurrence Count' => '2', 'Source Systems' => 'ip-nms' } }] }.to_json
ra = r0.merge('Find Active Alarm' => { 'Response Body' => act })
n = run(base, ra)
check 'repeat keeps existing alarm id', n['kind'] == 'repeat' && n['aid'] == 'ALM-EXISTING'
n = run(base.merge('state' => 'clear', 'vendorSeverity' => 'CL'), ra)
check 'clear applies to active', n['kind'] == 'clear'
n = run(base.merge('state' => 'clear', 'vendorSeverity' => 'CL', 'eventTime' => (now - 300).iso8601), ra)
check 'clear older than instance → orphan (out-of-order)', n['kind'] == 'orphan-clear'
n = run(base.merge('state' => 'clear', 'vendorSeverity' => 'CL'), r0)
check 'clear with no active → orphan', n['kind'] == 'orphan-clear'
n = run(base.merge('source' => 'ip-nms', 'vendorSeverity' => '3', 'condition' => '%LINK-3-UPDOWN'), r0)
check 'syslog 3 → Major, LINK-DOWN', n['sev'] == 'Major' && n['ct'] == 'LINK-DOWN'
n = run(base.merge('source' => 'ran-oss', 'resourceRef' => 'gNB-STP-C13', 'relatedResourceRef' => 'gNB-STP-C05', 'condition' => 'X2 link failure', 'vendorSeverity' => 'minor'), r0)
check 'related resource resolved', n['relid'] == 'GNB-STP-C05' && n['ct'] == 'X2-LINK-FAIL'
n = run(base.merge('condition' => 'SOMETHING-NEW'), r0)
check 'unknown condition → UNKNOWN + note', n['ct'] == 'UNKNOWN' && n['notes'].join.include?('unmapped condition')
check 'kql quote stripping', n['q'].call('a"b\\c') == 'abc'
check 'url encode no plus', n['enc'].call('values[A]="x y"') == 'values%5BA%5D%3D%22x%20y%22'
check 'own-tenant integration identity allowed', run(base, r0, 'int.borealis')['kind'] == 'new'
check 'other-tenant integration identity forbidden', run(base, r0, 'int.prairie')['kind'] == 'forbidden'
check 'unknown caller forbidden', run(base, r0, 'support.borealis')['kind'] == 'forbidden'
check 'missing requested_by forbidden', run(base, r0, nil)['kind'] == 'forbidden'
# before lookups have run (first node): @results missing keys must not raise
@requested_by = { 'username' => 'john' }; @request = { 'Body' => base.to_json }; @results = results({})
n = eval(NORM)
check 'evaluates with no upstream results (first node)', n['kind'] == 'new' && n['rid'] == ''
puts "#{$fail == 0 ? 'ALL PASS' : "#{$fail} FAILED"}"
exit($fail == 0 ? 0 : 1)
