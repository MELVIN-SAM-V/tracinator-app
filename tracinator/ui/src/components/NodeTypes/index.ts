import EntryExitNode from './EntryExitNode'
import StatementNode from './StatementNode'
import IfNode from './IfNode'
import LoopNode from './LoopNode'
import CallNode from './CallNode'
import RaiseNode from './RaiseNode'
import ExceptNode from './ExceptNode'
import TryNode from './TryNode'
import ReturnNode from './ReturnNode'
import GenericNode from './GenericNode'

export const nodeTypes = {
  ENTRY: EntryExitNode,
  EXIT: EntryExitNode,
  STATEMENT: StatementNode,
  IF: IfNode,
  ELIF: IfNode,
  FOR: LoopNode,
  WHILE: LoopNode,
  CALL: CallNode,
  RAISE: RaiseNode,
  EXCEPT: ExceptNode,
  TRY: TryNode,
  RETURN: ReturnNode,
  ELSE: GenericNode,
  WITH: GenericNode,
  FINALLY: GenericNode,
  BREAK: GenericNode,
  CONTINUE: GenericNode,
}
