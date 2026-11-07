"""Driver requests must not bypass dispatcher control or mutate existing work."""
from concurrent.futures import ThreadPoolExecutor
import test_dispatch_http as harness


class RefuelRequestTests(harness.HTTPScenario):
    def submit(self, token=None, **payload):
        return self.request('POST', '/driver/refuel-requests', {'reason': '现场剩余油量不足', **payload}, auth=token or self.driver)

    def resolve(self, identifier, action='approve', **payload):
        return self.post(f'/refuel-requests/{identifier}/resolve', {'action': action, **payload})

    def test_request_approve_driver_complete_preserves_work_until_approval(self):
        before = self.overview()
        requested = self.submit(reportedFuel=1200)['driver']['refuel_request']
        after = self.overview()
        self.assertEqual(before['vehicles'], after['vehicles'])
        self.assertEqual(before['tasks'], after['tasks'])
        self.assertEqual(requested['reported_fuel'], 1200)
        self.assertEqual(after['refuelRequests'][0]['id'], requested['id'])
        approved = self.resolve(requested['id'])['overview']
        self.assertEqual(approved['refuelRequests'][0]['status'], 'SCHEDULED')
        self.assertEqual(self.vehicle(approved, 'v1')['status'], 'REFUELLING')
        self.assertEqual(self.vehicle(approved, 'v1')['fuel_level'], self.vehicle(before, 'v1')['fuel_level'])
        self.post(f"/refuel-requests/{requested['id']}/resolve", {'action': 'approve'}, status=422)
        self.request('POST', '/vehicles/v1/refuel', {'action': 'complete'}, auth=self.dispatch, status=403)
        completed = self.request('POST', '/vehicles/v1/refuel', {'action': 'complete'}, auth=self.driver)
        self.assertEqual(completed['driver']['refuel_request']['status'], 'COMPLETED')
        self.assertEqual(self.overview()['refuelRequests'], [])

    def test_busy_driver_can_request_but_dispatch_cannot_interrupt_work(self):
        token = self.login('driver03', 'driver123')
        before = self.overview()
        requested = self.submit(token)['driver']['refuel_request']
        self.post(f"/refuel-requests/{requested['id']}/resolve", {'action': 'approve'}, status=422)
        after = self.overview()
        self.assertEqual(before['vehicles'], after['vehicles'])
        self.assertEqual(before['tasks'], after['tasks'])
        self.assertEqual(after['refuelRequests'][0]['status'], 'PENDING')
        self.resolve(requested['id'], 'reject', reason='请完成当前工单后申请')
        workspace = self.request('GET', '/driver/tasks', auth=token)
        self.assertEqual(workspace['driver']['refuel_request']['resolution'], '请完成当前工单后申请')
        self.assertEqual(workspace['driver']['refuel_request']['status'], 'REJECTED')
        self.assertNotEqual(self.submit(token)['driver']['refuel_request']['id'], requested['id'])

    def test_permissions_validation_duplicates_and_handoff(self):
        self.request('POST', '/driver/refuel-requests', {'reason': '申请车辆补油'}, auth=self.dispatch, status=403)
        for payload in [{'reason': ''}, {'reportedFuel': -1}, {'reportedFuel': True}, {'reportedFuel': 999999}, {'reportedFuel': 1.2}]:
            self.request('POST', '/driver/refuel-requests', {'reason': '申请车辆补油', **payload}, auth=self.driver, status=422)
        requested = self.submit()['driver']['refuel_request']
        self.request('POST', '/driver/refuel-requests', {'reason': '再次申请车辆补油'}, auth=self.driver, status=422)
        self.request('POST', f"/refuel-requests/{requested['id']}/resolve", {'action': 'approve'}, auth=self.driver, status=403)
        self.post(f"/refuel-requests/{requested['id']}/resolve", {'action': 'reject', 'reason': ''}, status=422)
        self.post('/dispatch/personnel/driver-v1/status', {'status': 'STANDBY', 'reason': '司机正常换班'})
        self.assertEqual(self.overview()['refuelRequests'], [])
        workspace = self.request('GET', '/driver/tasks', auth=self.driver)
        self.assertEqual(workspace['driver']['refuel_request']['status'], 'CANCELLED')
        self.request('POST', '/driver/refuel-requests', {'reason': '再次申请车辆补油'}, auth=self.driver, status=403)
        self.post(f"/refuel-requests/{requested['id']}/resolve", {'action': 'approve'}, status=422)

    def test_concurrent_requests_leave_one_open_request(self):
        def send(_):
            from urllib.request import Request, urlopen
            from urllib.error import HTTPError
            import json
            req = Request(self.base+'/driver/refuel-requests', data=json.dumps({'reason': '现场需要申请补油'}).encode(), headers={'Content-Type': 'application/json', 'Authorization': 'Bearer '+self.driver}, method='POST')
            try:
                with urlopen(req, timeout=5) as response: return response.status
            except HTTPError as error: return error.code
        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = sorted(pool.map(send, range(2)))
        self.assertEqual(statuses, [200, 422])
        self.assertEqual(len(self.overview()['refuelRequests']), 1)
