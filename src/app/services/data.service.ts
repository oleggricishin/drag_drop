import {Injectable} from '@angular/core';
import {Supplier} from '../models/supplier.model';
import {BehaviorSubject} from 'rxjs';
import {EventData} from '../models/event.model';
import {Week} from '../models/week.model';

@Injectable({
  providedIn: 'root' // This makes the service a singleton and tree-shakable
})
export class DataService {
  readyEventData$ = new BehaviorSubject<{suppliers: Supplier[], events: EventData[], weekRange: Week[]} | null>(null);
  suppliers$ = new BehaviorSubject<Supplier[]>([]);
  events$ = new BehaviorSubject<EventData[]>([]);

  constructor() {

  }
}
